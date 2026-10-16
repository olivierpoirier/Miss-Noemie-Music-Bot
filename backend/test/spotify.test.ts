import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const originalFetch = globalThis.fetch;
const credentialKeys = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN", "SPOTIFY_MARKET"] as const;
const originalEnv = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
let importId = 0;

beforeEach(() => {
  process.env.SPOTIFY_CLIENT_ID = "offline-client";
  process.env.SPOTIFY_CLIENT_SECRET = "offline-secret";
  delete process.env.SPOTIFY_REFRESH_TOKEN;
  delete process.env.SPOTIFY_MARKET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of credentialKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const freshResolver = () => import(new URL(`../src/spotify.ts?offline=${++importId}`, import.meta.url).href);
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
const token = (access_token = "offline-token") => json({ access_token, expires_in: 3600 });
const track = (id = "offline") => ({ id, name: `Track ${id}`, artists: [{ name: "Artist" }], duration_ms: 123000 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("concurrent Spotify imports share one token request", async () => {
  let tokenRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) {
      tokenRequests++;
      await flush();
      return token();
    }
    return json(track());
  };
  const { resolveSpotifyUrl } = await freshResolver();
  const items = await Promise.all(Array.from({ length: 10 }, () => resolveSpotifyUrl("spotify:track:offline")));
  assert.equal(tokenRequests, 1);
  assert.equal(items[0][0].url, "provider:spotify:Artist - Track offline");
});

test("a rejected access token is renewed once even with concurrent 401 responses", async () => {
  let tokenRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/api/token")) return token(`token-${++tokenRequests}`);
    if (new Headers(init?.headers).get("authorization") === "Bearer token-1") {
      await flush();
      return json({ error: "expired" }, 401);
    }
    return json(track());
  };
  const { resolveSpotifyUrl } = await freshResolver();
  await Promise.all(Array.from({ length: 5 }, () => resolveSpotifyUrl("spotify:track:offline")));
  assert.equal(tokenRequests, 2);
});

test("playlist requests use Spotify's 50-item page limit and stop at 200 tracks", async () => {
  let pages = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) return token();
    const endpoint = new URL(String(input));
    assert.equal(endpoint.searchParams.get("limit"), "50");
    assert.equal(endpoint.searchParams.get("market"), "FR");
    const currentPage = pages++;
    return json({
      items: Array.from({ length: 50 }, (_, index) => ({ item: track(`${currentPage}x${index}`) })),
      next: `https://api.spotify.com/v1/playlists/offline/items?limit=50&offset=${pages * 50}`,
    });
  };
  const { resolveSpotifyUrl } = await freshResolver();
  const items = await resolveSpotifyUrl("https://open.spotify.com/playlist/offline");
  assert.equal(items.length, 200);
  assert.equal(pages, 4);
});

test("unavailable playlist entries do not make pagination scan beyond its 200-item limit", async () => {
  let pages = 0;
  process.env.SPOTIFY_MARKET = "ca";
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) return token();
    const endpoint = new URL(String(input));
    assert.equal(endpoint.searchParams.get("market"), "CA");
    pages++;
    return json({
      items: Array.from({ length: 50 }, () => ({ item: null })),
      next: `https://api.spotify.com/v1/playlists/offline/items?limit=50&offset=${pages * 50}`,
    });
  };
  const { resolveSpotifyUrl } = await freshResolver();
  assert.deepEqual(await resolveSpotifyUrl("spotify:playlist:offline"), []);
  assert.equal(pages, 4);
});

test("a revoked refresh token keeps track metadata usable and is not retried on renewal", async () => {
  process.env.SPOTIFY_REFRESH_TOKEN = "revoked-offline";
  const grants: string[] = [];
  let apiRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/api/token")) {
      const grant = new URLSearchParams(init?.body as URLSearchParams).get("grant_type")!;
      grants.push(grant);
      return grant === "refresh_token" ? json({ error: "invalid_grant" }, 400) : token(`token-${grants.length}`);
    }
    return ++apiRequests === 1 ? json({}, 401) : json(track());
  };
  const { resolveSpotifyUrl } = await freshResolver();
  assert.equal((await resolveSpotifyUrl("spotify:track:offline")).length, 1);
  assert.deepEqual(grants, ["refresh_token", "client_credentials", "client_credentials"]);
});

test("playlist permission failures retain HTTP status and explain required authorization", async () => {
  globalThis.fetch = async (input) => String(input).includes("/api/token") ? token() : json({}, 403);
  const { resolveSpotifyUrl } = await freshResolver();
  await assert.rejects(resolveSpotifyUrl("spotify:playlist:offline"), {
    code: "SPOTIFY_PLAYLIST_NOT_ACCESSIBLE", status: 403,
  });
});

test("transient refresh errors recover without downgrading user access to client credentials", async (t) => {
  process.env.SPOTIFY_REFRESH_TOKEN = "offline-refresh-token";
  const { resolveSpotifyUrl } = await freshResolver();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const grants: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/api/token")) return json(track());
    grants.push(new URLSearchParams(init?.body as URLSearchParams).get("grant_type")!);
    return grants.length <= 3 ? json({}, 503) : token();
  };
  const result = assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_TOKEN_REQUEST_FAILED" });
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  await result;
  assert.equal((await resolveSpotifyUrl("spotify:track:offline")).length, 1);
  assert.deepEqual(grants, ["refresh_token", "refresh_token", "refresh_token", "refresh_token"]);
});

test("a long Spotify rate limit fails promptly without early retries", async () => {
  let apiRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) return token();
    apiRequests++;
    return json({}, 429, { "retry-after": "3600" });
  };
  const { resolveSpotifyUrl } = await freshResolver();
  await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_RATE_LIMITED", status: 429 });
  assert.equal(apiRequests, 1);
});

test("Spotify's quota deadline also applies to later imports and releases when it expires", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let apiRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) return token();
    return ++apiRequests === 1 ? json({}, 429, { "retry-after": "60" }) : json(track());
  };
  const { resolveSpotifyUrl } = await freshResolver();
  await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_RATE_LIMITED", status: 429 });
  await assert.rejects(resolveSpotifyUrl("spotify:track:another"), { code: "SPOTIFY_RATE_LIMITED", status: 429 });
  assert.equal(apiRequests, 1, "later queue additions must not extend the provider's quota rejection");
  now += 60_001;
  assert.equal((await resolveSpotifyUrl("spotify:track:offline")).length, 1);
  assert.equal(apiRequests, 2);
});

test("Spotify honors HTTP-date Retry-After values without retrying early", async () => {
  let apiRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) return token();
    apiRequests++;
    return json({}, 429, { "retry-after": new Date(Date.now() + 60_000).toUTCString() });
  };
  const { resolveSpotifyUrl } = await freshResolver();
  await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_RATE_LIMITED", status: 429 });
  await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_RATE_LIMITED", status: 429 });
  assert.equal(apiRequests, 1);
});

test("a quota rejection on token renewal is retained between imports", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return json({}, 429, { "retry-after": "60" });
  };
  const { resolveSpotifyUrl } = await freshResolver();
  for (let index = 0; index < 2; index++) {
    await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_RATE_LIMITED", status: 429 });
  }
  assert.equal(requests, 1);
});

test("invalid Spotify JSON never leaks response snippets through resolver errors", async () => {
  let tokenResponse = true;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/token")) return tokenResponse ? new Response('{"access_token":"private-secret"') : token();
    return new Response('{"private-secret":');
  };
  const { resolveSpotifyUrl } = await freshResolver();
  await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_TOKEN_INVALID", message: "Réponse d'authentification Spotify invalide." });
  tokenResponse = false;
  await assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_RESPONSE_INVALID", message: "Réponse de Spotify invalide. Réessaie dans un instant." });
});

test("hung Spotify response bodies are aborted and the resolver releases after bounded retries", async (t) => {
  const { resolveSpotifyUrl } = await freshResolver();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    return {
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    } as Response;
  };
  const result = assert.rejects(resolveSpotifyUrl("spotify:track:offline"), { code: "SPOTIFY_TIMEOUT" });
  await flush();
  for (let attempt = 0; attempt < 3; attempt++) {
    t.mock.timers.tick(12_000);
    await flush();
    t.mock.timers.tick(1_000);
    await flush();
  }
  await result;
  assert.equal(requests, 3);
});

test("Spotify pagination rejects untrusted next URLs without leaking the bearer token", async () => {
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    if (String(input).includes("/api/token")) return token();
    return json({ items: [{ item: track() }], next: "https://untrusted.invalid/collect" });
  };
  const { resolveSpotifyUrl } = await freshResolver();
  await assert.rejects(resolveSpotifyUrl("spotify:playlist:offline"), { code: "SPOTIFY_URL_INVALID" });
  assert.equal(requested.length, 2);
});
