const STORE_KEY = "__music_bot_vercel_demo_state__";

const DEFAULT_CONTROL = {
  paused: false,
  skipSeq: 0,
  repeat: false,
  randomMode: false,
  audioProfile: "balanced",
};

const PLAYLIST_HINTS = [
  "list",
  "playlist",
  "album",
  "sets",
  "collection",
];

const DEMO_PLAYLIST_MAX_ITEMS = 50;
const DEMO_FETCH_TIMEOUT_MS = 5500;
const RECENT_REQUEST_LIMIT = 80;
const RECENT_ADD_WINDOW_MS = 3500;

function createStore() {
  return {
    nextId: 1,
    control: { ...DEFAULT_CONTROL },
    now: null,
    queue: [],
    history: [],
    handledClientRequests: [],
    pendingClientRequests: [],
    pendingAdds: [],
    recentAdds: [],
  };
}

function getStore() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = createStore();
  }

  return globalThis[STORE_KEY];
}

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function normalizeInput(raw) {
  const value = String(raw || "").trim();

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.test(value)) {
    return `https://${value}`;
  }

  const query = encodeURIComponent(value || "music demo");
  return `https://www.youtube.com/results?search_query=${query}`;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function youtubeId(url) {
  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] || null;
  }

  if (host.endsWith("youtube.com")) {
    return url.searchParams.get("v");
  }

  return null;
}

function titleFromUrl(url, fallback) {
  const host = url.hostname.replace(/^www\./, "");
  const query = url.searchParams.get("search_query");

  if (query) {
    return decodeURIComponent(query.replace(/\+/g, " "));
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment.replace(/[-_]+/g, " ")));

  const label = segments.at(-1) || host;
  const cleaned = label.replace(/\.[a-z0-9]{2,5}$/i, "").trim();

  if (!cleaned || cleaned.length < 2) {
    return fallback;
  }

  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function playlistSourceLabel(url) {
  const host = url?.hostname?.replace(/^www\./, "") || "";
  const path = url?.pathname?.toLowerCase() || "";

  if (host.includes("youtube")) return "Playlist YouTube";
  if (host.includes("youtu.be")) return "Playlist YouTube";
  if (host.includes("spotify") && path.includes("/album/")) return "Album Spotify";
  if (host.includes("spotify")) return "Playlist Spotify";
  if (host.includes("soundcloud")) return "Playlist SoundCloud";

  return "Playlist";
}

function cleanText(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromRichText(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value);
  if (value.simpleText) return cleanText(value.simpleText);

  if (Array.isArray(value.runs)) {
    return cleanText(value.runs.map((run) => run?.text || "").join(""));
  }

  return cleanText(value.accessibility?.accessibilityData?.label || "");
}

function parseDurationSec(value) {
  const text = String(value || "").trim();
  if (!/^\d+(?::\d+){1,2}$/.test(text)) return 0;

  return text
    .split(":")
    .map((part) => Number(part) || 0)
    .reduce((total, part) => total * 60 + part, 0);
}

function youtubeThumbnail(videoId) {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
}

function bestThumbnailUrl(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return null;

  const sorted = [...thumbnails].sort((a, b) => {
    const aSize = (a?.width || 0) * (a?.height || 0);
    const bSize = (b?.width || 0) * (b?.height || 0);
    return bSize - aSize;
  });
  const url = sorted[0]?.url;

  if (!url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  return cleanText(url);
}

function playlistIdFromUrl(url) {
  const host = url.hostname.replace(/^www\./, "");

  if (!host.includes("youtube.com") && host !== "youtu.be") {
    return null;
  }

  return url.searchParams.get("list");
}

function youtubePlaylistItemUrl(videoId, playlistId) {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  url.searchParams.set("list", playlistId);
  return url.toString();
}

async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("fetch unavailable");
  }

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), DEMO_FETCH_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller?.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; MusicBotDemo/1.0; +https://vercel.app)",
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`fetch failed with ${response.status}`);
    }

    return response;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: { accept: "application/json" },
  });
  return response.json();
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  return response.text();
}

function extractJsonObjectAfter(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = html.indexOf("{", markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index += 1) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractYtInitialData(html) {
  const markers = [
    "var ytInitialData =",
    "window[\"ytInitialData\"] =",
    "ytInitialData =",
  ];

  for (const marker of markers) {
    const jsonText = extractJsonObjectAfter(html, marker);
    if (!jsonText) continue;

    try {
      return JSON.parse(jsonText);
    } catch {
      // Try the next marker.
    }
  }

  return null;
}

function collectPlaylistRenderers(node, output = []) {
  if (!node || output.length >= DEMO_PLAYLIST_MAX_ITEMS) {
    return output;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      collectPlaylistRenderers(entry, output);
      if (output.length >= DEMO_PLAYLIST_MAX_ITEMS) break;
    }
    return output;
  }

  if (typeof node !== "object") {
    return output;
  }

  const renderer = node.playlistVideoRenderer || node.playlistPanelVideoRenderer;
  if (renderer?.videoId && renderer?.title) {
    output.push(renderer);
  }

  for (const value of Object.values(node)) {
    collectPlaylistRenderers(value, output);
    if (output.length >= DEMO_PLAYLIST_MAX_ITEMS) break;
  }

  return output;
}

function mapYoutubeRenderer(renderer, playlistId) {
  const videoId = renderer.videoId;
  const title = textFromRichText(renderer.title);

  if (
    !videoId ||
    !title ||
    /^(deleted video|private video|unavailable)$/i.test(title)
  ) {
    return null;
  }

  const durationText = textFromRichText(renderer.lengthText);

  return {
    url: youtubePlaylistItemUrl(videoId, playlistId),
    title,
    thumb: bestThumbnailUrl(renderer.thumbnail?.thumbnails) || youtubeThumbnail(videoId),
    durationSec: parseDurationSec(durationText),
  };
}

async function resolveYoutubePlaylist(raw, playlistId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(
    playlistId
  )}&hl=fr&gl=CA`;
  const html = await fetchText(url);
  const initialData = extractYtInitialData(html);
  const renderers = collectPlaylistRenderers(initialData);
  const seen = new Set();
  const items = [];

  for (const renderer of renderers) {
    const item = mapYoutubeRenderer(renderer, playlistId);
    if (!item || seen.has(item.url)) continue;

    seen.add(item.url);
    items.push(item);

    if (items.length >= DEMO_PLAYLIST_MAX_ITEMS) {
      break;
    }
  }

  if (!items.length) {
    throw new Error(`No playlist entries found for ${raw}`);
  }

  return items;
}

function oEmbedEndpointsForUrl(url) {
  const host = url.hostname.replace(/^www\./, "");
  const encoded = encodeURIComponent(url.toString());
  const noembed = `https://noembed.com/embed?url=${encoded}`;

  if (host.includes("youtube.com") || host === "youtu.be") {
    return [
      `https://www.youtube.com/oembed?url=${encoded}&format=json`,
      noembed,
    ];
  }

  if (host.includes("spotify.com")) {
    return [`https://open.spotify.com/oembed?url=${encoded}`, noembed];
  }

  if (host.includes("soundcloud.com")) {
    return [
      `https://soundcloud.com/oembed?format=json&url=${encoded}`,
      noembed,
    ];
  }

  return [noembed];
}

async function resolveOEmbed(url) {
  for (const endpoint of oEmbedEndpointsForUrl(url)) {
    try {
      const data = await fetchJson(endpoint);
      const title = cleanText(data?.title);

      if (!title) {
        continue;
      }

      return {
        title,
        thumb: cleanText(data?.thumbnail_url) || null,
      };
    } catch {
      // Try the next public metadata endpoint.
    }
  }

  return null;
}

async function resolveSingleDemoItem(raw) {
  const normalized = normalizeInput(raw);
  const parsed = safeUrl(normalized);
  const idSeed = `${normalized}:single`;
  const durationSec = 130 + (hashString(idSeed) % 210);

  if (!parsed) {
    return {
      url: normalized,
      title: cleanText(raw) || "Signal demo",
      thumb: null,
      durationSec,
    };
  }

  const videoId = youtubeId(parsed);
  const metadata = await resolveOEmbed(parsed);
  const fallbackTitle = titleFromUrl(parsed, parsed.hostname);

  return {
    url: normalized,
    title: metadata?.title || fallbackTitle,
    thumb: metadata?.thumb || youtubeThumbnail(videoId),
    durationSec,
  };
}

function looksLikePlaylist(raw) {
  const value = String(raw || "").toLowerCase();
  return PLAYLIST_HINTS.some((hint) => value.includes(hint));
}

async function resolveDemoItems(raw) {
  const normalized = normalizeInput(raw);
  const parsed = safeUrl(normalized);
  const playlistId = parsed ? playlistIdFromUrl(parsed) : null;

  if (playlistId) {
    try {
      return await resolveYoutubePlaylist(raw, playlistId);
    } catch {
      // Keep the demo useful even when YouTube blocks metadata scraping.
    }
  }

  const singleItem = await resolveSingleDemoItem(raw);

  if (looksLikePlaylist(raw) && parsed) {
    singleItem.title = singleItem.title || playlistSourceLabel(parsed);
  }

  return [singleItem];
}

function buildQueueItem(resolved, addedBy, clientRequestId, index, group) {
  return {
    id: "",
    url: resolved.url,
    title: resolved.title || resolved.url,
    thumb: resolved.thumb || null,
    addedBy,
    group,
    status: "queued",
    createdAt: Date.now(),
    durationSec: resolved.durationSec || 0,
    clientRequestId: index === 0 ? clientRequestId : undefined,
  };
}

function computePosition(store) {
  const now = store.now;
  if (!now) return 0;

  if (store.control.paused || now.isBuffering || !now.startedAt) {
    return now.positionOffsetSec || 0;
  }

  return Math.max(0, (Date.now() - now.startedAt) / 1000);
}

function pushHistory(store, item) {
  if (!item) return;

  store.history.unshift({
    ...item,
    status: "done",
    startedAt: undefined,
    isBuffering: false,
    positionOffsetSec: 0,
  });

  store.history = store.history.slice(0, 80);
}

function startItem(store, item) {
  store.now = {
    ...item,
    status: undefined,
    startedAt: Date.now(),
    positionOffsetSec: 0,
    isBuffering: false,
  };
}

function startNext(store) {
  const next = store.queue.shift();

  if (next) {
    startItem(store, next);
  } else {
    store.now = null;
  }
}

function syncPlayback(store) {
  const now = store.now;
  if (!now || store.control.paused || now.isBuffering) return;

  const duration = now.durationSec || 0;
  if (!duration) return;

  const position = computePosition(store);
  if (position < duration) return;

  if (store.control.repeat) {
    now.startedAt = Date.now();
    now.positionOffsetSec = 0;
    return;
  }

  pushHistory(store, now);
  startNext(store);
}

function statePayload(store) {
  syncPlayback(store);

  const queued = store.queue.filter((item) => item.status === "queued");
  const remainingTimeSec = queued.reduce(
    (total, item) => total + (item.durationSec || 0),
    0
  );

  return {
    ok: true,
    now: store.now,
    queue: queued,
    history: store.history,
    control: store.control,
    stats: {
      totalQueued: queued.length,
      remainingTimeSec,
    },
  };
}

function ensureRequestTracking(store) {
  store.handledClientRequests = Array.isArray(store.handledClientRequests)
    ? store.handledClientRequests
    : [];
  store.pendingClientRequests = Array.isArray(store.pendingClientRequests)
    ? store.pendingClientRequests
    : [];
  store.pendingAdds = Array.isArray(store.pendingAdds) ? store.pendingAdds : [];
  store.recentAdds = Array.isArray(store.recentAdds) ? store.recentAdds : [];
}

function rememberLimited(list, value) {
  list.push(value);

  while (list.length > RECENT_REQUEST_LIMIT) {
    list.shift();
  }
}

function clientRequestKey(value) {
  return String(value || "").trim().slice(0, 120);
}

function isDuplicateClientRequest(store, clientRequestId) {
  const key = clientRequestKey(clientRequestId);
  if (!key) return false;

  ensureRequestTracking(store);

  return (
    store.handledClientRequests.includes(key) ||
    store.pendingClientRequests.includes(key)
  );
}

function markClientRequestPending(store, clientRequestId) {
  const key = clientRequestKey(clientRequestId);
  if (!key) return "";

  ensureRequestTracking(store);
  rememberLimited(store.pendingClientRequests, key);
  return key;
}

function markClientRequestHandled(store, key) {
  if (!key) return;

  ensureRequestTracking(store);
  store.pendingClientRequests = store.pendingClientRequests.filter(
    (item) => item !== key
  );
  rememberLimited(store.handledClientRequests, key);
}

function clearPendingClientRequest(store, key) {
  if (!key) return;

  ensureRequestTracking(store);
  store.pendingClientRequests = store.pendingClientRequests.filter(
    (item) => item !== key
  );
}

function recentAddKey(raw, addedBy) {
  return `${String(addedBy || "").toLowerCase()}:${normalizeInput(raw).toLowerCase()}`;
}

function pruneRecentAdds(store) {
  const cutoff = Date.now() - RECENT_ADD_WINDOW_MS;
  store.recentAdds = store.recentAdds.filter((entry) => entry.createdAt >= cutoff);
}

function wasRecentlyAdded(store, raw, addedBy) {
  ensureRequestTracking(store);
  pruneRecentAdds(store);

  const key = recentAddKey(raw, addedBy);
  return (
    store.pendingAdds.includes(key) ||
    store.recentAdds.some((entry) => entry.key === key)
  );
}

function rememberRecentAdd(store, raw, addedBy) {
  ensureRequestTracking(store);
  pruneRecentAdds(store);
  store.recentAdds.push({ key: recentAddKey(raw, addedBy), createdAt: Date.now() });
}

function markAddPending(store, raw, addedBy) {
  ensureRequestTracking(store);
  const key = recentAddKey(raw, addedBy);
  rememberLimited(store.pendingAdds, key);
  return key;
}

function clearPendingAdd(store, key) {
  if (!key) return;

  ensureRequestTracking(store);
  store.pendingAdds = store.pendingAdds.filter((item) => item !== key);
}

async function addQueueItems(store, raw, addedBy, clientRequestId) {
  if (isDuplicateClientRequest(store, clientRequestId)) {
    return { count: 0, duplicate: true };
  }

  if (wasRecentlyAdded(store, raw, addedBy)) {
    return { count: 0, duplicate: true };
  }

  const requestKey = markClientRequestPending(store, clientRequestId);
  const addKey = markAddPending(store, raw, addedBy);

  try {
    const resolvedItems = await resolveDemoItems(raw);
    const group =
      resolvedItems.length > 1
        ? `demo_${Date.now()}_${hashString(String(raw || ""))}`
        : undefined;
    const created = resolvedItems.map((resolved, index) => {
      const item = buildQueueItem(
        resolved,
        addedBy,
        clientRequestId,
        index,
        group
      );
      item.id = String(store.nextId);
      store.nextId += 1;
      return item;
    });
    const count = created.length;

    if (!count) {
      clearPendingAdd(store, addKey);
      clearPendingClientRequest(store, requestKey);
      return { count: 0, duplicate: false };
    }

    if (!store.now) {
      startItem(store, created.shift());
    }

    store.queue.push(...created);
    rememberRecentAdd(store, raw, addedBy);
    clearPendingAdd(store, addKey);
    markClientRequestHandled(store, requestKey);
    return { count, duplicate: false };
  } catch (error) {
    clearPendingAdd(store, addKey);
    clearPendingClientRequest(store, requestKey);
    throw error;
  }
}

function shuffle(items) {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]];
  }

  return copy;
}

function seekTo(store, positionSec) {
  if (!store.now) return;

  const duration = store.now.durationSec || 0;
  const position = Math.max(
    0,
    duration ? Math.min(Number(positionSec) || 0, duration) : Number(positionSec) || 0
  );

  store.now.positionOffsetSec = position;
  store.now.startedAt = store.control.paused
    ? null
    : Date.now() - position * 1000;
}

function handleCommand(store, cmd, arg) {
  switch (cmd) {
    case "pause": {
      if (store.now) {
        store.now.positionOffsetSec = computePosition(store);
        store.now.startedAt = null;
      }
      store.control.paused = true;
      break;
    }

    case "resume": {
      store.control.paused = false;
      if (store.now) {
        const offset = store.now.positionOffsetSec || 0;
        store.now.startedAt = Date.now() - offset * 1000;
      }
      break;
    }

    case "skip": {
      store.control.skipSeq += 1;
      pushHistory(store, store.now);
      startNext(store);
      break;
    }

    case "skip_group": {
      store.queue = [];
      pushHistory(store, store.now);
      store.now = null;
      break;
    }

    case "previous": {
      const previous = store.history.shift();
      if (!previous) break;

      if (store.now) {
        store.queue.unshift({
          ...store.now,
          id: String(store.nextId),
          status: "queued",
          createdAt: Date.now(),
          startedAt: undefined,
          isBuffering: undefined,
          positionOffsetSec: undefined,
        });
        store.nextId += 1;
      }

      startItem(store, {
        ...previous,
        id: String(store.nextId),
        status: "queued",
        createdAt: Date.now(),
      });
      store.nextId += 1;
      break;
    }

    case "seek": {
      seekTo(store, computePosition(store) + (Number(arg) || 0));
      break;
    }

    case "seek_abs": {
      seekTo(store, Number(arg) || 0);
      break;
    }

    case "repeat": {
      store.control.repeat = Boolean(arg);
      break;
    }

    case "random_mode": {
      store.control.randomMode = Boolean(arg);
      break;
    }

    case "shuffle_queue": {
      store.queue = shuffle(store.queue);
      break;
    }

    case "audio_profile": {
      store.control.audioProfile = arg === "xbox" ? "xbox" : "balanced";
      break;
    }

    default:
      break;
  }
}

async function readBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }

  let raw = "";

  for await (const chunk of req) {
    raw += chunk;
  }

  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const store = getStore();
  const url = new URL(req.url || "/", `https://${req.headers.host || "localhost"}`);
  const action = url.searchParams.get("action") || "state";

  try {
    if (action === "state") {
      send(res, 200, { ok: true, state: statePayload(store) });
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, {
        ok: false,
        state: statePayload(store),
        toast: "Action non disponible.",
      });
      return;
    }

    const body = await readBody(req);
    let toast;

    switch (action) {
      case "play": {
        const raw = String(body.url || "").trim();
        if (!raw) {
          toast = "Entrée vide.";
          break;
        }

        const result = await addQueueItems(
          store,
          raw,
          String(body.addedBy || "anon").slice(0, 32),
          String(body.clientRequestId || "")
        );
        if (result.duplicate) {
          toast = "Ajout deja traite.";
          break;
        }

        const count = result.count;
        toast = count > 1 ? `${count} titres ajoutés !` : "Titre ajouté !";
        break;
      }

      case "command": {
        handleCommand(store, String(body.cmd || ""), body.arg);
        break;
      }

      case "clear": {
        store.queue = [];
        pushHistory(store, store.now);
        store.now = null;
        break;
      }

      case "remove_queue_item": {
        const id = String(body.id || "");
        store.queue = store.queue.filter((item) => item.id !== id);
        break;
      }

      case "reorder_queue": {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const byId = new Map(store.queue.map((item) => [item.id, item]));
        const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
        const remaining = store.queue.filter((item) => !ids.includes(item.id));
        store.queue = [...ordered, ...remaining];
        break;
      }

      case "requeue_history_item": {
        const source = store.history.find((item) => item.id === String(body.id || ""));
        if (!source) break;

        const item = {
          ...source,
          id: String(store.nextId),
          status: "queued",
          createdAt: Date.now(),
          startedAt: undefined,
          isBuffering: undefined,
          positionOffsetSec: undefined,
        };
        store.nextId += 1;

        if (!store.now) {
          startItem(store, item);
        } else {
          const targetIndex =
            typeof body.targetIndex === "number"
              ? Math.max(0, Math.min(body.targetIndex, store.queue.length))
              : store.queue.length;
          store.queue.splice(targetIndex, 0, item);
        }
        break;
      }

      default:
        toast = "Action inconnue.";
        break;
    }

    send(res, 200, { ok: true, state: statePayload(store), toast });
  } catch (error) {
    send(res, 500, {
      ok: false,
      state: statePayload(store),
      toast: "Erreur du serveur demo.",
    });
  }
}

module.exports = handler;
