import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { PLAYER_CONFIG } from "./config.js";
import { isSoundCloudUrl, isYoutubeSearchUrl, isYoutubeUrl, normalizeMediaUrl } from "./platforms/index.js";

/** A stable provider page match, never an extracted/signed audio stream. */
export type ProviderMatch = {
  url: string;
  title?: string;
  thumb?: string | null;
  durationSec?: number;
};

type CacheValue = { value: ProviderMatch; exp: number };
type CacheFile = { version: 1; savedAt: number; entries: Array<[string, CacheValue]> };
const matches = new Map<string, CacheValue>();
const MAX_FILE_BYTES = 8 * 1024 * 1024;
let loaded = false;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> | null = null;

function limit(): number {
  return Math.max(1, Math.min(10_000, PLAYER_CONFIG.providerMatchCacheMax));
}

function isStableUrl(value: unknown, providerOnly: boolean): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    if (providerOnly && (!(isYoutubeUrl(value) || isSoundCloudUrl(value)) || isYoutubeSearchUrl(value))) return false;
    return ![...url.searchParams.keys()].some((key) =>
      /^(?:expire|expires|signature|sig|token|auth|authorization|cookie|policy|credential|x-amz-.+|x-goog-.+)$/i.test(key)
    );
  } catch {
    return false;
  }
}

function sanitizeMatch(value: unknown): ProviderMatch | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isStableUrl(raw.url, true)) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 1_000) : undefined;
  const durationSec = typeof raw.durationSec === "number" && Number.isFinite(raw.durationSec) && raw.durationSec >= 0
    ? Math.min(raw.durationSec, 604_800)
    : undefined;
  // Rebuild the object explicitly: arbitrary fields must never reach disk.
  return {
    url: normalizeMediaUrl(raw.url),
    ...(title ? { title } : {}),
    ...(isStableUrl(raw.thumb, false) ? { thumb: raw.thumb } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}

function trim(): void {
  const now = Date.now();
  for (const [key, entry] of matches) {
    if (entry.exp <= now) matches.delete(key);
  }
  while (matches.size > limit()) {
    const oldest = matches.keys().next();
    if (oldest.done) break;
    matches.delete(oldest.value);
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(PLAYER_CONFIG.providerMatchCachePath)) return;
    if (fs.statSync(PLAYER_CONFIG.providerMatchCachePath).size > MAX_FILE_BYTES) return;
    const parsed = JSON.parse(fs.readFileSync(PLAYER_CONFIG.providerMatchCachePath, "utf8")) as Partial<CacheFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
    const now = Date.now();
    const maxExpiry = now + PLAYER_CONFIG.providerMatchCacheTTLMs;
    for (const entry of parsed.entries.slice(-limit())) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, raw] = entry;
      if (typeof key !== "string" || key.length > 2_000 || !raw || !Number.isFinite(raw.exp) || raw.exp <= now) continue;
      const value = sanitizeMatch(raw.value);
      if (value) matches.set(key, { value, exp: Math.min(raw.exp, maxExpiry) });
    }
    trim();
  } catch (error) {
    console.warn("[provider-cache] failed to load", error instanceof Error ? error.name : "unknown");
  }
}

function schedulePersistence(): void {
  dirty = true;
  if (timer || writing) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flushProviderMatchCache();
  }, 100);
}

/** Await queued atomic writes; also useful for graceful shutdown. */
export async function flushProviderMatchCache(): Promise<void> {
  load();
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (writing) {
    await writing;
    if (dirty) return flushProviderMatchCache();
    return;
  }
  if (!dirty) return;
  dirty = false;
  trim();
  const target = PLAYER_CONFIG.providerMatchCachePath;
  const payload: CacheFile = { version: 1, savedAt: Date.now(), entries: [...matches.entries()] };
  // Measure entries once so trimming a large cache never becomes quadratic.
  const sizes = payload.entries.map((entry) => Buffer.byteLength(JSON.stringify(entry)) + 1);
  let bytes = sizes.reduce((total, size) => total + size, 128);
  let removedCount = 0;
  while (bytes > MAX_FILE_BYTES && removedCount < payload.entries.length) {
    matches.delete(payload.entries[removedCount][0]);
    bytes -= sizes[removedCount++];
  }
  payload.entries = payload.entries.slice(removedCount);
  const serialized = JSON.stringify(payload);
  writing = (async () => {
    const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      console.warn("[provider-cache] failed to persist", error instanceof Error ? error.name : "unknown");
    }
  })();
  try {
    await writing;
  } finally {
    writing = null;
  }
  if (dirty) await flushProviderMatchCache();
}

export function getProviderMatch(key: string): ProviderMatch | null {
  load();
  const entry = matches.get(key);
  if (!entry) return null;
  if (entry.exp <= Date.now()) {
    matches.delete(key);
    schedulePersistence();
    return null;
  }
  return { ...entry.value };
}

export function setProviderMatch(key: string, value: ProviderMatch): void {
  load();
  if (!key || key.length > 2_000) return;
  const safe = sanitizeMatch(value);
  if (!safe) return;
  // Reinsert to retain recently refreshed matches when trimming.
  matches.delete(key);
  matches.set(key, { value: safe, exp: Date.now() + PLAYER_CONFIG.providerMatchCacheTTLMs });
  trim();
  schedulePersistence();
}

export function deleteProviderMatch(key: string): void {
  load();
  if (matches.delete(key)) schedulePersistence();
}

export function getProviderMatchCacheSize(): number {
  load();
  trim();
  return matches.size;
}
