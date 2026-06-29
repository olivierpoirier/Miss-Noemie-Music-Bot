import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { io, Socket } from "socket.io-client";
import type { QueueResponse, Command, QueueItem } from "../types";
import useVercelDemoQueue from "./useVercelDemoQueue";
import { IS_VERCEL_DEMO, SOCKET_SERVER_URL } from "../lib/runtime";

type BusyState =
  | Command
  | "play"
  | "clear"
  | "reorder_queue"
  | "remove_queue_item"
  | "requeue_history_item"
  | null;

const BUSY_TIMEOUT = 30_000;
const PENDING_MAX_AGE_MS = 60_000;

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
    control: { paused: false, skipSeq: 0, repeat: false, randomMode: false },
    stats: { totalQueued: 0, remainingTimeSec: 0 },
  });

  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const [toast, setToast] = useState("");
  const [systemError, setSystemError] = useState<string | null>(null);
  const [busy, setBusyState] = useState<BusyState>(null);

  const socketRef = useRef<Socket | null>(null);
  const busyTimerRef = useRef<number | null>(null);

  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setPendingItems((prev) =>
        prev.filter((item) => Date.now() - item.createdAt < PENDING_MAX_AGE_MS)
      );
    }, 2000);

    return () => clearInterval(id);
  }, []);

  const clearBusy = useCallback(() => {
    setBusyState(null);

    if (busyTimerRef.current) {
      clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  const setBusy = useCallback((value: BusyState) => {
    setBusyState(value);

    if (busyTimerRef.current) {
      clearTimeout(busyTimerRef.current);
    }

    busyTimerRef.current = window.setTimeout(() => {
      setBusyState(null);
    }, BUSY_TIMEOUT);
  }, []);

  useEffect(() => {
    const s = io(SOCKET_SERVER_URL || undefined, {
      transports: ["websocket"],
    });

    socketRef.current = s;

    s.on("state", (payload: QueueResponse) => {
      const queue = payload.queue ?? [];
      const now = payload.now ?? null;

      setPendingItems((prev) =>
        prev.filter((pending) => {
          const foundInQueue = queue.some(
            (q) =>
              q.clientRequestId &&
              pending.clientRequestId &&
              q.clientRequestId === pending.clientRequestId
          );

          const foundInNow =
            Boolean(now?.clientRequestId) &&
            Boolean(pending.clientRequestId) &&
            now?.clientRequestId === pending.clientRequestId;

          return !foundInQueue && !foundInNow;
        })
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
        },
        stats: payload.stats ?? { totalQueued: 0, remainingTimeSec: 0 },
      });

      clearBusy();
    });

    s.on("error_system", (message?: string) => {
      setSystemError(message || "Virtual audio routing is not available on the server.");
    });

    s.on("toast", (msg: string) => {
      setToast(msg);
      setTimeout(() => setToast(""), 4500);
    });

    s.on("connect", () => {
      setToast("🔗 Connecté au serveur");
      setTimeout(() => setToast(""), 4500);
    });

    s.on("disconnect", () => {
      setToast("⚡ Connexion perdue");
      clearBusy();
    });

    return () => {
      s.close();
    };
  }, [clearBusy]);

  const emitSafe = useCallback(
    (event: string, payload?: unknown, busyKey?: BusyState) => {
      if (!socketRef.current?.connected) {
        setToast("❌ Erreur : Serveur hors ligne");
        return;
      }

      if (busyKey) {
        setBusy(busyKey);
      }

      socketRef.current.emit(event, payload);
    },
    [setBusy]
  );

  const play = useCallback(
    (url: string, addedBy?: string) => {
      if (!socketRef.current?.connected) {
        setToast("❌ Erreur : Serveur hors ligne");
        return;
      }

      const clientRequestId = makeClientRequestId();

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
      setBusy("play");

      socketRef.current.emit("play", {
        url,
        addedBy,
        clientRequestId,
      });
    },
    [setBusy]
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
      },
    };
  }, [pendingItems, serverState]);

  return {
    state: mergedState,
    toast,
    setToast,
    systemError,
    setSystemError,
    play,
    command,
    busy,
    setBusy,
    clear,
    reorderQueue,
    removeQueueItem,
    requeueHistoryItem,
  };
}

const useLiveQueue = IS_VERCEL_DEMO ? useVercelDemoQueue : useSocketQueue;

export default useLiveQueue;
