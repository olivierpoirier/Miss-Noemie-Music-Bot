const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const handler = require('../../api/demo.js');

const STORE_KEY = '__music_bot_vercel_demo_state__';
const source = fs.readFileSync(path.join(__dirname, '../src/lib/demo-api.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const clientModule = import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

async function call(action, body, method = action === 'state' ? 'GET' : 'POST') {
  const headers = {};
  let response;
  await handler({ method, url: `/api/demo?action=${action}`, headers: {}, body }, {
    setHeader(name, value) { headers[name] = value; },
    end(raw) { response = { status: this.statusCode, body: JSON.parse(raw), headers }; },
  });
  return response;
}

function setup(t) {
  delete global[STORE_KEY];
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ title: 'Demo track' }),
  }));
  t.after(() => delete global[STORE_KEY]);
}

async function add(url, id) {
  return call('play', { url: `https://example.test/${url}`, clientRequestId: id || url });
}

test('demo clear without a payload is sent as POST; only state uses GET', async (t) => {
  const { requestDemo } = await clientModule;
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, state: { queue: [] } }) };
  });
  await requestDemo('clear');
  await requestDemo('state');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.cache, 'no-store');
});

test('demo request deadline covers a response body stalled after headers', async (t) => {
  const { requestDemo, DEMO_REQUEST_TIMEOUT } = await clientModule;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(global, 'fetch', async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }));
  const pending = requestDemo('state');
  const rejected = assert.rejects(pending, /trop de temps/);
  await new Promise(setImmediate);
  t.mock.timers.tick(DEMO_REQUEST_TIMEOUT);
  await rejected;
});

test('unmount cancellation aborts an in-flight demo request', async (t) => {
  const { requestDemo } = await clientModule;
  t.mock.method(global, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const controller = new AbortController();
  const rejected = assert.rejects(requestDemo('state', undefined, { signal: controller.signal }), /cancelled/);
  controller.abort();
  await rejected;
});

test('malformed demo bodies return 400 and never mutate playback', async (t) => {
  setup(t);
  for (const body of ['{', 'null', '[]']) {
    assert.equal((await call('play', body)).status, 400);
  }
  assert.equal((await call('play', ' '.repeat(65537))).status, 413);
  assert.equal(global[STORE_KEY].now, null);
});

test('reordering repeated IDs never duplicates queued songs', async (t) => {
  setup(t);
  await add('a');
  await add('b');
  await add('c');
  const ids = global[STORE_KEY].queue.map(item => item.id);
  const response = await call('reorder_queue', { ids: [ids[1], ids[1], ids[0]] });
  assert.deepEqual(response.body.state.queue.map(item => item.id), [ids[1], ids[0]]);
});

test('skip group removes its songs and preserves the following group', async (t) => {
  setup(t);
  await add('a');
  await add('b');
  await add('c');
  const store = global[STORE_KEY];
  store.now.group = 'album-a';
  store.queue[0].group = 'album-a';
  store.queue[1].group = 'album-b';
  const response = await call('command', { cmd: 'skip_group' });
  assert.equal(response.body.state.now.group, 'album-b');
  assert.equal(response.body.state.queue.length, 0);
});

test('clear cancels a song whose metadata is still resolving', async (t) => {
  setup(t);
  let finish;
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: () => new Promise(resolve => { finish = resolve; }),
  }));
  const pending = add('pending');
  await new Promise(setImmediate);
  const cleared = await call('clear', {});
  finish({ title: 'Late song' });
  const response = await pending;
  assert.equal(cleared.body.state.now, null);
  assert.equal(response.body.state.now, null);
  assert.equal(response.body.toast, 'Ajout annulé.');
});

test('metadata fetch deadline also covers reading the body', async (t) => {
  setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  t.mock.method(global, 'fetch', async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('metadata stalled'));
      }, { once: true });
    }),
  }));
  const pending = add('deadline');
  await new Promise(setImmediate);
  t.mock.timers.tick(5500);
  const response = await pending;
  assert.equal(aborted, true);
  assert.equal(response.status, 200);
  assert.match(response.body.state.now.url, /deadline/);
});

test('repeated resume preserves the clock and paused seek resumes at its offset', async (t) => {
  setup(t);
  await add('timing');
  const store = global[STORE_KEY];
  store.now.startedAt -= 1000;
  const startedAt = store.now.startedAt;
  await call('command', { cmd: 'resume' });
  assert.equal(store.now.startedAt, startedAt);
  await call('command', { cmd: 'pause' });
  await call('command', { cmd: 'seek_abs', arg: 45 });
  assert.equal(store.now.positionOffsetSec, 45);
  await call('command', { cmd: 'resume' });
  assert.ok(Math.abs((Date.now() - store.now.startedAt) / 1000 - 45) < 0.1);
});

test('returning after browser sleep advances across all elapsed songs', async (t) => {
  setup(t);
  await add('a');
  await add('b');
  await add('c');
  const store = global[STORE_KEY];
  const nextDuration = store.queue[0].durationSec;
  store.now.startedAt = Date.now() - (store.now.durationSec + nextDuration + 10) * 1000;
  const response = await call('state');
  assert.match(response.body.state.now.url, /\/c$/);
  assert.ok(Math.abs((Date.now() - response.body.state.now.startedAt) / 1000 - 10) < 0.1);
  assert.equal(response.body.state.history.length, 2);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('Twitch clip previews use the clips player for both link formats', async () => {
  const embedSource = fs.readFileSync(path.join(__dirname, '../src/lib/embed.ts'), 'utf8');
  const embedJs = ts.transpileModule(embedSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const { getVideoEmbed } = await import(`data:text/javascript;base64,${Buffer.from(embedJs).toString('base64')}`);
  for (const link of ['https://clips.twitch.tv/TestSlug', 'https://twitch.tv/channel/clip/TestSlug']) {
    const embed = getVideoEmbed(link, { muted: true, autoplay: false });
    const url = new URL(embed.src);
    assert.equal(url.origin, 'https://clips.twitch.tv');
    assert.equal(url.pathname, '/embed');
    assert.equal(url.searchParams.get('clip'), 'TestSlug');
    assert.equal(url.searchParams.get('muted'), 'true');
    assert.equal(url.searchParams.get('autoplay'), 'false');
    assert.equal(url.searchParams.get('parent'), 'localhost');
  }
  assert.equal(getVideoEmbed('https://twitch.tv.evil.test/channel'), null);
  assert.equal(getVideoEmbed('ftp://youtube.com/watch?v=test'), null);
});
