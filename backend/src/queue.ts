import { state, nextId } from "./types.js";
import type { GlobalState, QueueItem, ResolvedItem } from "./types.js";

const HISTORY_LIMIT = 200;

type QueueEntry = Omit<QueueItem, "id" | "createdAt" | "status"> & {
  status?: QueueItem["status"];
};
type QueueStore = Pick<GlobalState, "queue" | "history">;

/** Queue mutations stay synchronous; playback and cancellation belong to player.ts. */
export function createQueueService(
  store: QueueStore,
  ids: { current: number },
  options: { now?: () => number; random?: () => number } = {}
) {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());

  function enqueue(entry: QueueEntry): QueueItem {
    const item: QueueItem = {
      ...entry,
      id: String(ids.current++),
      createdAt: now(),
      status: entry.status ?? "queued",
      thumb: entry.thumb ?? null,
    };
    store.queue.push(item);
    return item;
  }

  function enqueueCollection(
    entries: ResolvedItem[],
    metadata: Pick<QueueItem, "addedBy" | "clientRequestId">
  ): QueueItem[] {
    const group = entries.length > 1 ? `pl_${ids.current}` : undefined;
    return entries.map((entry, index) => enqueue({
      url: entry.url,
      title: entry.title || "Titre en attente...",
      thumb: entry.thumb ?? null,
      durationSec: entry.durationSec || 0,
      addedBy: metadata.addedBy,
      group,
      clientRequestId: index === 0 ? metadata.clientRequestId : undefined,
    }));
  }

  function reorder(idsInOrder: readonly string[]): void {
    const ids = [...new Set(idsInOrder)];
    const selectedIds = new Set(ids);
    const queued = store.queue.filter((item) => item.status === "queued");
    const byId = new Map(queued.map((item) => [item.id, item]));
    const reordered = ids
      .map((id) => byId.get(id))
      .filter((item): item is QueueItem => item !== undefined);
    store.queue = [
      ...store.queue.filter((item) => item.status !== "queued"),
      ...reordered,
      ...queued.filter((item) => !selectedIds.has(item.id)),
    ];
  }

  function shuffle(): void {
    const queued = store.queue.filter((item) => item.status === "queued");
    for (let i = queued.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [queued[i], queued[j]] = [queued[j], queued[i]];
    }
    store.queue = [...store.queue.filter((item) => item.status !== "queued"), ...queued];
  }

  // The caller must cancel playback before removing an active item.
  function remove(id: string): "missing" | "playing" | "removed" {
    const item = store.queue.find((entry) => entry.id === id);
    if (!item) return "missing";
    if (item.status === "playing") return "playing";
    item.status = "done";
    return "removed";
  }

  function clear(): void {
    for (const item of store.queue) {
      if (item.status === "queued" || item.status === "playing") item.status = "done";
    }
  }

  function finishQueuedGroup(group: string): void {
    for (const item of store.queue) {
      if (item.status === "queued" && item.group === group) item.status = "done";
    }
  }

  function addToHistory(item: QueueItem): void {
    store.history = [
      { ...item, status: "done" as const },
      ...store.history.filter((entry) => entry.id !== item.id),
    ].slice(0, HISTORY_LIMIT);
  }

  function requeueHistory(id: string, targetIndex?: number): QueueItem | null {
    const source = store.history.find((item) => item.id === id);
    if (!source) return null;
    const item = enqueue({
      url: source.url,
      sourceUrl: source.sourceUrl,
      title: source.title || "Titre en attente...",
      thumb: source.thumb,
      durationSec: source.durationSec || 0,
      addedBy: source.addedBy,
      group: source.group,
    });
    const queued = store.queue.filter((entry) => entry.status === "queued" && entry !== item);
    const insertAt = typeof targetIndex === "number" && Number.isFinite(targetIndex)
      ? Math.max(0, Math.min(Math.floor(targetIndex), queued.length))
      : queued.length;
    queued.splice(insertAt, 0, item);
    store.queue = [...store.queue.filter((entry) => entry.status !== "queued"), ...queued];
    return item;
  }

  function restorePrevious(currentItem: QueueItem | null): QueueItem | null {
    const previous = store.history[0];
    if (!previous) return null;
    store.history = store.history.slice(1);
    const restored: QueueItem = {
      ...previous,
      id: String(ids.current++),
      createdAt: now(),
      status: "queued",
    };
    const completed = store.queue.filter((item) => item.status !== "queued" && item.status !== "playing");
    const queued = store.queue.filter((item) => item.status === "queued" && item.id !== currentItem?.id);
    if (currentItem) currentItem.status = "queued";
    store.queue = [...completed, restored, ...(currentItem ? [currentItem] : []), ...queued];
    return restored;
  }

  function snapshot() {
    // Retire completed entries after the player has made its history snapshot.
    store.queue = store.queue.filter((item) =>
      item.status === "queued" || item.status === "playing" || item.status === "pending"
    );
    const queued = store.queue.filter((item) => item.status === "queued");
    return {
      queue: queued,
      history: store.history.slice(0, HISTORY_LIMIT),
      stats: {
        totalQueued: queued.length,
        remainingTimeSec: queued.reduce((total, item) => total + (item.durationSec || 0), 0),
      },
    };
  }

  return {
    enqueue, enqueueCollection, reorder, shuffle, remove, clear,
    finishQueuedGroup, addToHistory, requeueHistory, restorePrevious, snapshot,
  };
}

export const queueService = createQueueService(state, nextId);
