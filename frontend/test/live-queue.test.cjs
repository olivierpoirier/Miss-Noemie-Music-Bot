const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real hook against a socket and a minimal hook lifecycle. No
// browser, running backend, or network calls are needed for reconnect races.
function harness(t) {
  class Socket extends EventEmitter {
    connected = true;
    sent = [];
    connectCount = 0;
    emit(event, payload) { this.sent.push([event, payload]); return true; }
    receive(event, payload) {
      if (event === 'disconnect') this.connected = false;
      if (event === 'connect') this.connected = true;
      return super.emit(event, payload);
    }
    connect() { this.connectCount++; return this; }
    close() { this.connected = false; }
  }
  const socket = new Socket();
  const slots = [];
  const effects = [];
  const cleanup = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous[i])) {
        effects.push(() => {
          cleanup[index]?.();
          cleanup[index] = effect();
        });
        slots[index] = dependencies;
      }
    },
  };
  const toasts = [];
  const busyRef = { current: null };
  const feedback = {
    busyRef,
    setBusy: value => { busyRef.current = value; },
    clearBusy: () => { busyRef.current = null; },
    setToast: value => toasts.push(value),
    setSystemError() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/hooks/useLiveQueue.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    crypto: require('node:crypto').webcrypto,
    Date, Math, Set, clearInterval,
    window: { setTimeout, clearTimeout, setInterval },
    require(name) {
      if (name === 'react') return react;
      if (name === 'socket.io-client') return { io: () => socket };
      if (name === '../lib/runtime') return { IS_VERCEL_DEMO: false, SOCKET_SERVER_URL: '' };
      if (name === './useQueueFeedback') return { default: () => feedback };
      if (name === './useVercelDemoQueue') return { default() { throw new Error('Unexpected demo transport'); } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const render = () => {
    cursor = 0;
    const result = exports.default();
    for (const effect of effects.splice(0)) effect();
    return result;
  };
  const unmount = () => { for (const effect of cleanup.splice(0)) effect?.(); };
  t.after(unmount);
  return { socket, busyRef, render, unmount, toasts };
}

test('an unconfirmed add stays locked across disconnect and resolves with the new server state', t => {
  const h = harness(t);
  let queue = h.render();
  assert.equal(queue.play('first song'), true);
  const request = h.socket.sent.find(([event]) => event === 'play')[1];
  h.socket.receive('disconnect', 'transport close');
  h.socket.receive('connect_error', new Error('offline'));
  assert.equal(h.busyRef.current, 'play');
  h.socket.receive('connect');
  queue = h.render();
  assert.equal(queue.play('first song'), false);
  assert.equal(h.socket.sent.filter(([event]) => event === 'play').length, 1);

  h.socket.receive('state', { queue: [{ id: 'confirmed', clientRequestId: request.clientRequestId }], now: null });
  queue = h.render();
  assert.equal(queue.state.queue.length, 1);
  assert.equal(queue.state.queue[0].id, 'confirmed');
  assert.equal(h.busyRef.current, null);
  assert.equal(queue.play('second song'), true);
});

test('a failed add acknowledged after reconnect releases its request', t => {
  const h = harness(t);
  const queue = h.render();
  queue.play('first song');
  const request = h.socket.sent.find(([event]) => event === 'play')[1];
  h.socket.receive('disconnect', 'transport error');
  h.socket.receive('connect');
  h.socket.receive('play_result', { clientRequestId: request.clientRequestId, ok: false, message: 'Not available' });
  assert.equal(h.render().state.queue.length, 0);
  assert.equal(h.busyRef.current, null);
  assert.equal(queue.play('retry'), true);
});

test('explicit server disconnect reconnects once; unmount cancels a scheduled reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  h.render();
  h.socket.receive('disconnect', 'io server disconnect');
  h.socket.receive('disconnect', 'io server disconnect');
  t.mock.timers.tick(999);
  assert.equal(h.socket.connectCount, 0);
  t.mock.timers.tick(1);
  assert.equal(h.socket.connectCount, 1);
  h.socket.receive('connect');
  h.socket.receive('disconnect', 'io server disconnect');
  h.unmount();
  t.mock.timers.tick(10_000);
  assert.equal(h.socket.connectCount, 1);
  assert.equal(h.socket.listenerCount('state'), 0);
});

test('an add with no confirmation expires even when its connection was lost', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const h = harness(t);
  h.render().play('unconfirmed song');
  h.render();
  h.socket.receive('disconnect', 'transport close');
  h.socket.receive('connect');
  t.mock.timers.tick(5 * 60_000);
  const queue = h.render();
  assert.equal(queue.state.queue.length, 0);
  assert.equal(h.busyRef.current, null);
  assert.match(h.toasts.at(-1), /n'a pas été confirmé/);
  assert.equal(queue.play('retry after checking the queue'), true);
});
