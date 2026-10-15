const assert = require('node:assert/strict');
const { test } = require('node:test');
const handler = require('../../api/demo.js');

const STORE_KEY = '__music_bot_vercel_demo_state__';

async function command(cmd, arg) {
  let result;
  await handler({
    method: 'POST', url: '/api/demo?action=command', headers: {}, body: { cmd, arg },
  }, {
    setHeader() {},
    end(raw) { result = JSON.parse(raw); },
  });
  return result;
}

test('demo skipping while paused anchors the next track only when playback resumes', async (t) => {
  t.after(() => delete global[STORE_KEY]);
  global[STORE_KEY] = {
    control: { paused: true, skipSeq: 0, repeat: false, randomMode: false, audioProfile: 'balanced' },
    now: { url: 'https://example.test/first', durationSec: 100, positionOffsetSec: 25, startedAt: null, isBuffering: false },
    queue: [{ id: '2', url: 'https://example.test/next', thumb: null, status: 'queued', createdAt: 0, durationSec: 100 }],
    history: [],
  };
  const skipped = await command('skip');
  assert.equal(skipped.state.now.url, 'https://example.test/next');
  assert.equal(skipped.state.now.startedAt, null);
  assert.equal(skipped.state.now.positionOffsetSec, 0);
  const resumed = await command('resume');
  assert.equal(resumed.state.control.paused, false);
  assert.ok(Math.abs(Date.now() - resumed.state.now.startedAt) < 1000);
});
