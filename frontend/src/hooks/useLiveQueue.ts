import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { io, Socket } from "socket.io-client";
import type { QueueResponse, Command, QueueItem } from "../types";
import useVercelDemoQueue from "./useVercelDemoQueue";
import { IS_VERCEL_DEMO, SOCKET_SERVER_URL } from "../lib/runtime";
import useQueueFeedback, { type BusyState } from "./useQueueFeedback";

const BUSY_TIMEOUT = 30_000;
const PENDING_MAX_AGE_MS = 5 * 60_000;

function makeClientRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

type PendingItem = QueueItem & {
  status: "pending";
};

function useSocketQueue() {
  const [serverState, setServerState] = useState<QueueResponse>({
    ok: true,
    now: null,
    queue: [],
    history: [],
    control: { paused: false, skipSeq: 0, repeat: false, randomMode: false, audioProfile: "balanced" },
    stats: { totalQueued: 0, remainingTimeSec: 0 },
  });

  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const feedback = useQueueFeedback(BUSY_TIMEOUT);
  const { setToast, setSystemError, busyRef, clearBusy, setBusy } = feedback;

  const socketRef = useRef<Socket | null>(null);
  const activeRequestRef = useRef<string | null>(null);

  useEffect(() => {
    if (pendingItems.length === 0) return;

    const id = window.setInterval(() => {
      const active = pendingItems.find((item) => item.clientRequestId === activeRequestRef.current);
      if (active && Date.now() - active.createdAt >= PENDING_MAX_AGE_MS) {
        activeRequestRef.current = null;
        if (busyRef.current === "play") clearBusy();
        setToast("L'ajout n'a pas été confirmé. Vérifie la file avant de réessayer.");
      }
      setPendingItems((prev) => {
        const next = prev.filter(
          (item) => Date.now() - item.createdAt < PENDING_MAX_AGE_MS
        );

        return next.length === prev.length ? prev : next;
      });
    }, 2000);

    return () => clearInterval(id);
  }, [pendingItems, busyRef, clearBusy, setToast]);

  useEffect(() => {
    const s = io(SOCKET_SERVER_URL || undefined, {
      transports: ["websocket", "polling"],
      tryAllTransports: true,
    });

    socketRef.current = s;
    let reconnectTimer: number | null = null;

    s.on("state", (payload: QueueResponse) => {
      const queue = payload.queue ?? [];
      const now = payload.now ?? null;
      const resolvedIds = new Set(
        [...queue, ...(payload.history ?? []), ...(now ? [now] : [])]
          .map((item) => item.clientRequestId)
          .filter(Boolean)
      );

      setPendingItems((prev) =>
        prev.filter((pending) => !resolvedIds.has(pending.clientRequestId))
      );

      setServerState({
        ok: payload.ok ?? true,
        now,
        queue,
        history: payload.history ?? [],
        control: payload.control ?? {
          paused: false,
          skipSeq: 0,
          repeat: false,
          randomMode: false,
          audioProfile: "balanced",
        },
        stats: payload.stats ?? { totalQueued: 0, remainingTimeSec: 0 },
      });

      // Background progress updates must not unlock an unresolved Spotify or
      // playlist request and allow the same form to be submitted again.
      if (busyRef.current !== "play" || resolvedIds.has(activeRequestRef.current ?? "")) {
        if (resolvedIds.has(activeRequestRef.current ?? "")) activeRequestRef.current = null;
        clearBusy();
      }
    });

    s.on("play_result", (result: { clientRequestId?: string; ok: boolean; message?: string }) => {
      if (result.clientRequestId) {
        setPendingItems((prev) => prev.filter((item) => item.clientRequestId !== result.clientRequestId));
        if (result.clientRequestId === activeRequestRef.current) {
          activeRequestRef.current = null;
          if (busyRef.current === "play") clearBusy();
        }
      }
      if (!result.ok && result.message) setToast(result.message);
    });

    s.on("error_system", (message?: string | null) => {
      setSystemError(message ?? null);
    });

    s.on("toast", (msg: string) => {
      setToast(msg);
    });

    s.on("connect", () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      setToast("🔗 Connecté au serveur");
      setSystemError(null);
    });

    s.on("connect_error", () => {
      setToast("⚡ Serveur inaccessible. Reconnexion automatique…");
      if (!activeRequestRef.current) clearBusy();
    });

    s.on("disconnect", (reason: string) => {
      setToast(activeRequestRef.current
        ? "⚡ Connexion perdue. L'ajout reste en attente de confirmation."
        : "⚡ Connexion perdue");
      // The server can finish an import while this browser reconnects. Keep
      // its request until the next state/ack or deadline to prevent a second add.
      if (!activeRequestRef.current) clearBusy();
      if (reason === "io server disconnect" && reconnectTimer === null) {
        // Socket.IO automatically reconnects transport failures, but an
        // explicit server disconnect requires a new connect() call.
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          s.connect();
        }, 1_000);
      }
    });

    return () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socketRef.current = null;
      s.removeAllListeners();
      s.close();
    };
  }, [busyRef, clearBusy, setSystemError, setToast]);

  const emitSafe = useCallback(
    (event: string, payload?: unknown, busyKey?: BusyState) => {
      if (!socketRef.current?.connected) {
        setToast("❌ Erreur : Serveur hors ligne");
        return false;
      }

      if (busyKey) {
        setBusy(busyKey);
      }

      socketRef.current.emit(event, payload);
      return true;
    },
    [setBusy, setToast]
  );

  const play = useCallback(
    (url: string, addedBy?: string) => {
      if (!socketRef.current?.connected) {
        setToast("❌ Erreur : Serveur hors ligne");
        return false;
      }
      if (activeRequestRef.current) {
        setToast("Un ajout est déjà en cours. Patiente encore un instant.");
        return false;
      }

      const clientRequestId = makeClientRequestId();
      activeRequestRef.current = clientRequestId;

      const pendingItem: PendingItem = {
        id: `pending_${clientRequestId}`,
        clientRequestId,
        createdAt: Date.now(),
        status: "pending",
        url,
        title: "Envoi au serveur...",
        thumb: null,
        addedBy: addedBy || "anon",
        durationSec: 0,
      };

      setPendingItems((prev) => [pendingItem, ...prev].slice(0, 8));
      setBusy("play", PENDING_MAX_AGE_MS);

      socketRef.current.emit("play", {
        url,
        addedBy,
        clientRequestId,
      });
      return true;
    },
    [setBusy, setToast]
  );

  const command = (cmd: Command, arg?: number | string) =>
    emitSafe("command", { cmd, arg }, cmd);

  const clear = () => emitSafe("clear", undefined, "clear");

  const reorderQueue = (ids: string[]) =>
    emitSafe("reorder_queue", { ids }, "reorder_queue");

  const removeQueueItem = (id: string) =>
    emitSafe("remove_queue_item", { id }, "remove_queue_item");

  const requeueHistoryItem = (id: string, targetIndex?: number) =>
    emitSafe(
      "requeue_history_item",
      { id, targetIndex },
      "requeue_history_item"
    );

  const mergedState = useMemo<QueueResponse>(() => {
    return {
      ...serverState,
      queue: [...pendingItems, ...(serverState.queue ?? [])],
      control: serverState.control ?? {
        paused: false,
        skipSeq: 0,
        repeat: false,
        randomMode: false,
        audioProfile: "balanced",
      },
    };
  }, [pendingItems, serverState]);

  return {
    state: mergedState,
    ...feedback,
    play,
    command,
    clear,
    reorderQueue,
    removeQueueItem,
    requeueHistoryItem,
  };
}

const useLiveQueue = IS_VERCEL_DEMO ? useVercelDemoQueue : useSocketQueue;

export default useLiveQueue;
