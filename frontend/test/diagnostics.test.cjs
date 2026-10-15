const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/diagnostics.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const diagnosticsModule = import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function snapshot() {
  return {
    ok: true,
    timestamp: '2026-10-15T12:00:00.000Z',
    server: { uptimeSec: 42, activeUsers: 1, queued: 3, idleShutdownMs: 0 },
    player: { engineRunning: true, starting: false, loading: false, buffering: false, paused: false, retryCount: 1 },
    audioRouting: { ready: true, degraded: false, message: null },
    tools: {
      ytDlp: {
        path: '/app/backend/node_modules/yt-dlp/bin/yt-dlp',
        version: '2026.10.01',
        checkedAt: '2026-10-15T11:00:00.000Z',
        status: 'warning',
        ageDays: 14,
        message: 'Vérifier les mises à jour.',
      },
    },
    recentEvents: [{ timestamp: '2026-10-15T11:59:00.000Z', level: 'info', category: 'player', code: 'recovered', message: 'Lecture reprise.' }],
    logging: { enabled: true, available: true },
  };
}

test('diagnostic export keeps only public fields, including nested tool and event data', async () => {
  const { parseDiagnostics } = await diagnosticsModule;
  const body = snapshot();
  body.environment = { SECRET: 'test-secret' };
  body.tools.ytDlp.stderr = 'private-stderr';
  body.player.rawUrl = 'https://example.test/private';
  body.recentEvents[0].stack = 'private-stack';
  body.recentEvents[0].details = { status: 429, reason: 'rate_limit', url: 'private-url', trackId: 'private-track' };
  const result = parseDiagnostics(body);
  const expected = snapshot();
  expected.recentEvents[0].details = { status: 429, reason: 'rate_limit' };
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('recent diagnostic events are bounded and sorted newest first regardless of server ordering', async () => {
  const { parseDiagnostics } = await diagnosticsModule;
  const body = snapshot();
  body.recentEvents = Array.from({ length: 120 }, (_, index) => ({
    ...body.recentEvents[0], timestamp: new Date(Date.parse(body.timestamp) + index * 1_000).toISOString(),
  }));
  const result = parseDiagnostics(body);
  assert.equal(result.recentEvents.length, 100);
  assert.equal(result.recentEvents[0].timestamp, body.recentEvents[119].timestamp);
  assert.equal(result.recentEvents[99].timestamp, body.recentEvents[20].timestamp);
});

test('malformed diagnostic snapshots fail without reaching the renderer', async () => {
  const { parseDiagnostics } = await diagnosticsModule;
  for (const mutate of [
    body => { body.ok = false; },
    body => { body.server.uptimeSec = '42'; },
    body => { body.player.paused = null; },
    body => { body.tools.ytDlp.status = 'unexpected'; },
    body => { body.recentEvents[0].timestamp = 'not a date'; },
    body => { body.recentEvents = null; },
  ]) {
    const body = snapshot();
    mutate(body);
    assert.throws(() => parseDiagnostics(body), /diagnostics invalides/);
  }
});

test('diagnostic requests use the configured backend with cache disabled', async (t) => {
  const { requestDiagnostics } = await diagnosticsModule;
  let call;
  t.mock.method(global, 'fetch', async (url, options) => {
    call = { url, options };
    return { ok: true, json: async () => snapshot() };
  });
  const result = await requestDiagnostics({ baseUrl: 'https://bot.example.test/' });
  assert.equal(call.url, 'https://bot.example.test/diagnostics');
  assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.headers.Accept, 'application/json');
  assert.deepEqual(result, snapshot());
});

test('diagnostic deadline includes a body stalled after headers', async (t) => {
  const { requestDiagnostics, DIAGNOSTIC_REQUEST_TIMEOUT } = await diagnosticsModule;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  t.mock.method(global, 'fetch', async (_url, options) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }),
  }));
  const rejected = assert.rejects(requestDiagnostics(), /trop de temps/);
  await new Promise(setImmediate);
  t.mock.timers.tick(DIAGNOSTIC_REQUEST_TIMEOUT);
  await rejected;
  assert.equal(aborted, true);
});

test('closing diagnostics cancels the request without reporting a timeout', async (t) => {
  const { requestDiagnostics } = await diagnosticsModule;
  t.mock.method(global, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('request-cancelled')), { once: true });
  }));
  const controller = new AbortController();
  const rejected = assert.rejects(requestDiagnostics({ signal: controller.signal }), /request-cancelled/);
  controller.abort();
  await rejected;
});

test('HTTP and non-JSON responses yield a concise diagnostic error', async (t) => {
  const { requestDiagnostics } = await diagnosticsModule;
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 503 }));
  await assert.rejects(requestDiagnostics(), /HTTP 503/);
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected HTML document'); },
  }));
  await assert.rejects(requestDiagnostics(), /diagnostics invalides/);
});
