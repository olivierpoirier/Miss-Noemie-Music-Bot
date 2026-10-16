import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { PLAYER_CONFIG } from "../src/config.js";
import { diagnostics } from "../src/diagnostics.js";

const original = { ...PLAYER_CONFIG };
let directory: string;
let cachePath: string;
let serial = 0;
const fresh = () => import(new URL(`../src/providerCache.ts?merge=${++serial}`, import.meta.url).href);
const match = (id: string) => ({ url: `https://www.youtube.com/watch?v=${id}`, title: "Artist - Song", durationSec: 180 });

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmbot-provider-cache-"));
  cachePath = path.join(directory, "cache.json");
  Object.assign(PLAYER_CONFIG, { providerMatchCachePath: cachePath, providerMatchCacheMax: 3, providerMatchCacheTTLMs: 60_000 });
});

afterEach(() => {
  Object.assign(PLAYER_CONFIG, original);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("provider matches persist atomically, reload and stay isolated from caller mutations", async () => {
  const cache = await fresh();
  const value = match("abcdefghijk");
  cache.setProviderMatch("spotify|artist song|180", value);
  value.title = "changed";
  const retrieved = cache.getProviderMatch("spotify|artist song|180");
  assert.equal(retrieved.title, "Artist - Song");
  retrieved.title = "also changed";
  await cache.flushProviderMatchCache();
  const reloaded = await fresh();
  assert.equal(reloaded.getProviderMatch("spotify|artist song|180").title, "Artist - Song");
  assert.deepEqual(fs.readdirSync(directory), ["cache.json"]);
});

test("provider cache rejects signed streams, credentials and arbitrary private fields", async () => {
  const cache = await fresh();
  cache.setProviderMatch("signed", { url: "https://www.youtube.com/watch?v=abcdefghijk&token=secret" });
  cache.setProviderMatch("stream", { url: "https://rr1.googlevideo.com/videoplayback?expire=123" });
  cache.setProviderMatch("credentials", { url: "https://private:secret@youtube.com/watch?v=abcdefghijk" });
  cache.setProviderMatch("safe", { ...match("abcdefghijk"), cookies: "private", headers: { Authorization: "private" }, thumb: "https://image.invalid/img?token=private" });
  await cache.flushProviderMatchCache();
  assert.equal(cache.getProviderMatchCacheSize(), 1);
  const stored = fs.readFileSync(cachePath, "utf8");
  assert.ok(!stored.includes("private"));
  assert.deepEqual(cache.getProviderMatch("safe"), match("abcdefghijk"));
});

test("provider cache expires entries, bounds capacity and preserves removals on disk", async () => {
  const cache = await fresh();
  for (let index = 0; index < 6; index++) cache.setProviderMatch(`item-${index}`, match(`abcdefghij${index}`));
  assert.equal(cache.getProviderMatchCacheSize(), 3);
  assert.equal(cache.getProviderMatch("item-0"), null);
  cache.deleteProviderMatch("item-5");
  await cache.flushProviderMatchCache();
  assert.equal((await fresh()).getProviderMatchCacheSize(), 2);
  const stored = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  stored.entries[0][1].exp = Date.now() - 1;
  fs.writeFileSync(cachePath, JSON.stringify(stored));
  assert.equal((await fresh()).getProviderMatchCacheSize(), 1);
});

test("corrupt provider cache is ignored and replaced by a valid version", async () => {
  fs.writeFileSync(cachePath, "{invalid json");
  const cache = await fresh();
  assert.equal(cache.getProviderMatchCacheSize(), 0);
  assert.ok(diagnostics.events().some((event) => event.code === "PROVIDER_CACHE_FAILED" && event.details?.stage === "cache_load"));
  cache.setProviderMatch("valid", match("abcdefghijk"));
  await cache.flushProviderMatchCache();
  assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).version, 1);
});

test("provider cache persistence failures are diagnosed while memory matching remains available", async () => {
  const cache = await fresh();
  fs.mkdirSync(cachePath);
  cache.setProviderMatch("valid", match("abcdefghijk"));
  await cache.flushProviderMatchCache();
  assert.equal(cache.getProviderMatch("valid").url, match("abcdefghijk").url);
  assert.ok(diagnostics.events().some((event) => event.code === "PROVIDER_CACHE_FAILED" && event.details?.stage === "cache_write"));
});

test("provider updates during an asynchronous write are included in the final snapshot", async () => {
  const cache = await fresh();
  cache.setProviderMatch("one", match("abcdefghijk"));
  const writing = cache.flushProviderMatchCache();
  cache.setProviderMatch("two", match("lmnopqrstuv"));
  await Promise.all([writing, cache.flushProviderMatchCache()]);
  const reloaded = await fresh();
  assert.equal(reloaded.getProviderMatchCacheSize(), 2);
  assert.ok(reloaded.getProviderMatch("two"));
});
