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

function createStore() {
  return {
    nextId: 1,
    control: { ...DEFAULT_CONTROL },
    now: null,
    queue: [],
    history: [],
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

function buildDemoItem(raw, addedBy, clientRequestId, index = 0) {
  const normalized = normalizeInput(raw);
  const parsed = safeUrl(normalized);
  const idSeed = `${normalized}:${index}`;
  const durationSec = 130 + (hashString(idSeed) % 210);

  if (!parsed) {
    return {
      id: "",
      url: normalized,
      title: String(raw || "Signal demo"),
      thumb: null,
      addedBy,
      status: "queued",
      createdAt: Date.now(),
      durationSec,
      clientRequestId,
    };
  }

  const videoId = youtubeId(parsed);
  const baseTitle = titleFromUrl(parsed, parsed.hostname);
  const title =
    index > 0
      ? `${baseTitle} - extrait ${index + 1}`
      : baseTitle;

  return {
    id: "",
    url: normalized,
    title,
    thumb: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
    addedBy,
    status: "queued",
    createdAt: Date.now(),
    durationSec,
    clientRequestId: index === 0 ? clientRequestId : undefined,
  };
}

function looksLikePlaylist(raw) {
  const value = String(raw || "").toLowerCase();
  return PLAYLIST_HINTS.some((hint) => value.includes(hint));
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

function addQueueItems(store, raw, addedBy, clientRequestId) {
  const count = looksLikePlaylist(raw) ? 3 : 1;
  const created = [];

  for (let index = 0; index < count; index += 1) {
    const item = buildDemoItem(raw, addedBy, clientRequestId, index);
    item.id = String(store.nextId);
    store.nextId += 1;
    created.push(item);
  }

  if (!store.now) {
    startItem(store, created.shift());
  }

  store.queue.push(...created);
  return count;
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

        const count = addQueueItems(
          store,
          raw,
          String(body.addedBy || "anon").slice(0, 32),
          String(body.clientRequestId || "")
        );
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
