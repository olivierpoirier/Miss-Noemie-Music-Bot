import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { YTDLP_CONFIG } from "../src/config.js";
import { diagnostics } from "../src/diagnostics.js";

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
    const format = args[args.indexOf('-f') + 1];
    const withCookies = args.includes('--cookies') || args.includes('--cookies-from-browser');
    if (target.searchParams.has('authenticated-combined') || target.searchParams.has('authenticated-audio')) {
      const failure = !withCookies ? 'Sign in to confirm your age.'
        : args.includes('--extractor-args') ? 'The following content is not available on this app.'
        : format === 'bestaudio' && target.searchParams.has('authenticated-combined') ? 'Requested format is not available.' : null;
      if (failure) {
        fs.writeSync(2, 'ERROR: [youtube] ' + failure);
        process.exit(1);
      }
    }
    if (target.searchParams.has('authenticated-format-fails')) {
      fs.writeSync(2, 'ERROR: [youtube] ' + (withCookies
        ? 'Requested format is not available.' : 'Sign in to confirm your age.'));
      process.exit(1);
    }
    if (target.searchParams.has('access-denied')) {
      const reason = target.searchParams.get('access-denied');
      const failures = {
        age_restricted: 'Sign in to confirm your age.',
        login_required: 'Login required.',
        bot_check: "Sign in to confirm you're not a bot.",
        cookies_invalid: 'The cookies provided are no longer valid.'
      };
      fs.writeSync(2, 'ERROR: [youtube] ' + (format === 'bestaudio'
        ? failures[reason] : 'The following content is not available on this app.')
        + ' https://private.invalid/stream?token=private-secret');
      process.exit(1);
    }
    if ((target.searchParams.has('cookies-fail') && withCookies)
      || (target.searchParams.has('audio-fails') && format === 'bestaudio')) {
      fs.writeSync(2, 'HTTP Error 403: unavailable source');
      process.exit(1);
    }
    if (target.searchParams.has('fail')) {
      fs.writeSync(2, 'HTTP Error 403: https://private.invalid/audio?token=private-secret');
      process.exit(1);
    }
    if (target.searchParams.has('hang')) setInterval(() => {}, 1000);
    else setTimeout(() => {
    const output = {
      url: 'https://media.invalid/audio?run=' + run + '&expire=' + (target.searchParams.get('expire') || Math.floor(Date.now() / 1000 + (target.searchParams.has('stale-first') && run === 1 ? -10 : 600))),
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
  assert.equal(await getPlayableSource(target), null, "an expired source must never reach the player");
  assert.equal(await getPlayableSource(target), null);
  assert.equal(calls().length, 2);
});

test("an already expired YouTube extraction falls through to a fresh strategy before loading MPV", async () => {
  const { getPlayableSource } = await freshResolver();
  const source = await getPlayableSource("https://www.youtube.com/watch?v=offline1234&stale-first=1");
  assert.ok(source?.expiresAt && source.expiresAt > Date.now());
  assert.equal(calls().length, 2);
});

test("provider diagnostics retain HTTP failure classification without exposing media URLs or subprocess stderr", async (t) => {
  const output: unknown[][] = [];
  for (const method of ["log", "warn", "error"] as const) t.mock.method(console, method, (...args: unknown[]) => output.push(args));
  const { getPlayableSource } = await freshResolver();
  assert.equal(await getPlayableSource("https://fixture.invalid/track?fail=1&token=private-secret"), null);
  const events = diagnostics.events();
  assert.ok(events.some((event) => event.code === "YTDLP_PROCESS_FAILED" && event.details?.status === 403));
  assert.ok(events.some((event) => event.code === "MEDIA_RESOLUTION_FAILED" && event.details?.platform === "generic" && event.details?.stage === "extraction"));
  const observed = JSON.stringify({ output, events });
  assert.ok(!observed.includes("private-secret"));
  assert.ok(!observed.includes("private.invalid"));
  assert.ok(!observed.includes("fixture.invalid"));
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

test("YouTube uses audio-only quality selection across containers for both profiles", async () => {
  const { getPlayableSource } = await freshResolver();
  for (const profile of ["balanced", "xbox"] as const) {
    assert.ok(await getPlayableSource("https://www.youtube.com/watch?v=offline1234", profile));
  }
  assert.equal(calls().length, 2);
  for (const attempt of calls()) {
    assert.equal(attempt[attempt.indexOf("-f") + 1], "bestaudio");
  }
});

test("rejected YouTube cookies try public audio before a combined video fallback", async () => {
  YTDLP_CONFIG.hasCookies = true;
  YTDLP_CONFIG.cookiesPath = path.join(directory, "cookies.txt");
  const { getPlayableSource } = await freshResolver();
  for (const profile of ["balanced", "xbox"] as const) {
    const source = await getPlayableSource("https://www.youtube.com/watch?v=offline1234&cookies-fail=1", profile);
    assert.equal(source?.debugLabel, "youtube-bestaudio-public");
  }
  const attempts = calls();
  assert.equal(attempts.length, 4);
  for (let index = 0; index < attempts.length; index++) {
    assert.equal(attempts[index][attempts[index].indexOf("-f") + 1], "bestaudio");
    assert.equal(attempts[index].includes("--cookies"), index % 2 === 0);
  }
});

test("unavailable YouTube audio retains the compatible MP4 fallback", async () => {
  const { getPlayableSource } = await freshResolver();
  const source = await getPlayableSource("https://www.youtube.com/watch?v=offline1234&audio-fails=1");
  assert.match(source?.debugLabel || "", /^youtube-mpv-safe-/);
  const attempts = calls();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0][attempts[0].indexOf("-f") + 1], "bestaudio");
  assert.equal(attempts[1][attempts[1].indexOf("-f") + 1], YTDLP_CONFIG.youtubeMpvSafeFormat);
});

test("authenticated YouTube combined streams use cookie-compatible automatic clients for both profiles", async () => {
  YTDLP_CONFIG.youtubePlayerClients = "android";
  const { getPlayableSource } = await freshResolver();
  for (const profile of ["balanced", "xbox"] as const) {
    for (const cookieSource of ["file", "browser"] as const) {
      YTDLP_CONFIG.hasCookies = cookieSource === "file";
      YTDLP_CONFIG.cookiesPath = cookieSource === "file" ? path.join(directory, "cookies.txt") : null;
      YTDLP_CONFIG.cookiesFromBrowser = cookieSource === "browser" ? "firefox" : "";
      const before = calls().length;
      const source = await getPlayableSource(`https://www.youtube.com/watch?v=offline1234&authenticated-combined=1&cookies=${cookieSource}`, profile);
      assert.equal(source?.debugLabel, "youtube-mpv-safe-authenticated-cookies");
      const attempts = calls().slice(before);
      assert.equal(attempts.length, 4);
      assert.equal(attempts[0][attempts[0].indexOf("--extractor-args") + 1], "youtube:player_client=android");
      assert.equal(attempts[1][attempts[1].indexOf("-f") + 1], "bestaudio");
      assert.ok(!attempts[1].includes("--extractor-args"));
      assert.ok(attempts[3].includes(cookieSource === "file" ? "--cookies" : "--cookies-from-browser"));
      assert.ok(!attempts[3].includes("--extractor-args"));
      assert.equal(attempts[3][attempts[3].indexOf("-f") + 1], YTDLP_CONFIG.youtubeMpvSafeFormat);
    }
  }
});

test("authenticated automatic clients retain audio-only quality before combined YouTube fallback", async () => {
  YTDLP_CONFIG.youtubePlayerClients = "android";
  YTDLP_CONFIG.hasCookies = true;
  YTDLP_CONFIG.cookiesPath = path.join(directory, "cookies.txt");
  const { getPlayableSource } = await freshResolver();
  for (const profile of ["balanced", "xbox"] as const) {
    const before = calls().length;
    const source = await getPlayableSource("https://www.youtube.com/watch?v=offline1234&authenticated-audio=1", profile);
    assert.equal(source?.debugLabel, "youtube-bestaudio-authenticated-cookies");
    const attempts = calls().slice(before);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1][attempts[1].indexOf("-f") + 1], "bestaudio");
    assert.ok(attempts[1].includes("--cookies"));
    assert.ok(!attempts[1].includes("--extractor-args"));
  }
});

test("YouTube access refusals remain actionable after later client failures without leaking stderr", async (t) => {
  const output: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => output.push(args));
  const { getPlayableSource } = await freshResolver();
  for (const [reason, code] of [
    ["age_restricted", "YOUTUBE_AGE_RESTRICTED"],
    ["login_required", "YOUTUBE_LOGIN_REQUIRED"],
    ["bot_check", "YOUTUBE_BOT_CHECK"],
    ["cookies_invalid", "YOUTUBE_COOKIES_INVALID"],
  ]) {
    assert.equal(await getPlayableSource(`https://www.youtube.com/watch?v=offline1234&access-denied=${reason}`), null);
    const events = diagnostics.events();
    const failure = events.find((event) => event.code === "MEDIA_RESOLUTION_FAILED");
    assert.equal(failure?.details?.reason, reason);
    assert.equal(failure?.details?.stage, "extraction");
    assert.ok(events.some((event) => event.code === code && event.details?.reason === reason));
  }
  assert.equal(output.length, 4);
  const observed = JSON.stringify({ output, events: diagnostics.events() });
  assert.ok(!observed.includes("private-secret"));
  assert.ok(!observed.includes("private.invalid"));
});

test("public age refusals do not hide format failures from an authenticated YouTube session", async () => {
  YTDLP_CONFIG.hasCookies = true;
  YTDLP_CONFIG.cookiesPath = path.join(directory, "cookies.txt");
  const { getPlayableSource } = await freshResolver();
  for (const profile of ["balanced", "xbox"] as const) {
    assert.equal(await getPlayableSource("https://www.youtube.com/watch?v=offline1234&authenticated-format-fails=1", profile), null);
    const failure = diagnostics.events().find((event) => event.code === "MEDIA_RESOLUTION_FAILED");
    assert.equal(failure?.details?.reason, "format_unavailable");
  }
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
