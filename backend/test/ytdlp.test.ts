import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { YTDLP_CONFIG } from "../src/config.js";

const originalConfig = { ...YTDLP_CONFIG };
let directory: string;
let logPath: string;
let importId = 0;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmbot-extractor-test-"));
  logPath = path.join(directory, "calls.jsonl");
  const runner = path.join(directory, "extractor.cjs");
  fs.writeFileSync(runner, `
    const fs = require('node:fs');
    const args = process.argv.slice(3);
    const logPath = process.argv[2];
    fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
    const run = fs.readFileSync(logPath, 'utf8').trim().split('\\n').length;
    const target = new URL(args.at(-1));
    if (target.searchParams.has('fail')) process.exit(1);
    if (target.searchParams.has('hang')) setInterval(() => {}, 1000);
    else setTimeout(() => {
    const output = {
      url: 'https://media.invalid/audio?run=' + run + '&expire=' + (target.searchParams.get('expire') || Math.floor(Date.now() / 1000 + 600)),
      format_id: 'offline-format', ext: 'm4a',
      http_headers: { 'User-Agent': 'offline-agent', Cookie: 'private', Authorization: 'private', 'Bad-Header': 'bad\\r\\nInjected: yes' }
    };
    if (target.searchParams.has('split')) {
      delete output.url;
      output.requested_formats = [
        { url: 'https://media.invalid/video', acodec: 'none', vcodec: 'h264' },
        { url: 'https://media.invalid/audio', acodec: 'opus', vcodec: 'none', format_id: 'audio-only', ext: 'webm' }
      ];
    }
    fs.writeSync(1, JSON.stringify(output));
    }, target.searchParams.has('race') && run === 1 ? 150 : 10);
  `);
  Object.assign(YTDLP_CONFIG, {
    bin: process.execPath,
    baseArgs: [runner, logPath],
    hasCookies: false,
    cookiesPath: null,
    cookiesFromBrowser: "",
    youtubePlayerClients: "",
    processTimeoutMs: 2_000,
  });
});

afterEach(() => {
  Object.assign(YTDLP_CONFIG, originalConfig);
  fs.rmSync(directory, { recursive: true, force: true });
});

const freshResolver = () => import(new URL(`../src/ytdlp.ts?offline=${++importId}`, import.meta.url).href);
const calls = () => fs.existsSync(logPath)
  ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
  : [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("parallel source resolution shares one extraction and filters unsafe headers", async () => {
  const { getPlayableSource } = await freshResolver();
  const sources = await Promise.all(Array.from({ length: 8 }, () => getPlayableSource("https://fixture.invalid/track")));
  assert.equal(calls().length, 1);
  assert.deepEqual(sources[0]?.headers, ["User-Agent: offline-agent"]);
  assert.ok(sources[0]?.expiresAt && sources[0].expiresAt > Date.now());
  assert.equal((await getPlayableSource("https://fixture.invalid/track"))?.url, sources[0]?.url);
  assert.equal(calls().length, 1);
});

test("expired signed sources are re-extracted instead of staying cached", async () => {
  const { getPlayableSource } = await freshResolver();
  const target = `https://fixture.invalid/track?expire=${Math.floor(Date.now() / 1000 - 10)}`;
  await getPlayableSource(target);
  await getPlayableSource(target);
  assert.equal(calls().length, 2);
});

test("split extraction selects the audio stream instead of the first video-only format", async () => {
  const { getPlayableSource } = await freshResolver();
  const source = await getPlayableSource("https://fixture.invalid/track?split=1");
  assert.equal(source?.url, "https://media.invalid/audio");
  assert.equal(source?.formatId, "audio-only");
  assert.equal(source?.ext, "webm");
});

test("source invalidation detaches in-flight extraction and prevents stale cache writes", async () => {
  const { getPlayableSource, invalidatePlayableSource } = await freshResolver();
  const target = "https://fixture.invalid/track?race=1";
  const stale = getPlayableSource(target);
  for (let attempt = 0; calls().length === 0 && attempt < 100; attempt++) await delay(10);
  assert.equal(calls().length, 1);
  invalidatePlayableSource(target);
  const fresh = await getPlayableSource(target);
  const old = await stale;
  assert.notEqual(old?.url, fresh?.url);
  assert.equal((await getPlayableSource(target))?.url, fresh?.url);
  assert.equal(calls().length, 2);
});

test("missing cookies do not duplicate YouTube extraction attempts and custom clients are retained", async () => {
  YTDLP_CONFIG.youtubePlayerClients = "configured-client";
  const { getPlayableSource } = await freshResolver();
  assert.equal(await getPlayableSource("https://www.youtube.com/watch?v=offline1234&fail=1"), null);
  const attempts = calls();
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0][attempts[0].indexOf("--extractor-args") + 1], "youtube:player_client=configured-client");
  assert.equal(attempts[1][attempts[1].indexOf("--extractor-args") + 1], "youtube:player_client=android");
});

test("a hung extractor is killed and source resolution releases within its total deadline", async () => {
  YTDLP_CONFIG.processTimeoutMs = 200;
  const { getPlayableSource } = await freshResolver();
  const started = Date.now();
  assert.equal(await getPlayableSource("https://fixture.invalid/track?hang=1"), null);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(calls().length, 1);
});

test("malformed percent encoding on a direct media URL does not crash metadata resolution", async () => {
  const { probeSingle } = await freshResolver();
  const item = await probeSingle("https://fixture.invalid/broken%ZZ.mp3");
  assert.ok(item.title);
  assert.equal(calls().length, 0);
});
