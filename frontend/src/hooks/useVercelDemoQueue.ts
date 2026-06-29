import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, QueueResponse } from "../types";

type BusyState =
  | Command
  | "play"
  | "clear"
  | "reorder_queue"
  | "remove_queue_item"
  | "requeue_history_item"
  | null;

type DemoResponse = {
  ok: boolean;
  state: QueueResponse;
  toast?: string;
};

const DEMO_API_BASE = import.meta.env.VITE_DEMO_API_BASE || "/api/demo";
const BUSY_TIMEOUT = 12_000;

const emptyState = (): QueueResponse => ({
  ok: true,
  now: null,
  queue: [],
  history: [],
  control: {
    paused: false,
    skipSeq: 0,
    repeat: false,
    randomMode: false,
    audioProfile: "balanced",
  },
  stats: { totalQueued: 0, remainingTimeSec: 0 },
});

function makeClientRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function requestDemo(
  action: string,
  payload?: Record<string, unknown>
): Promise<DemoResponse> {
  const response = await fetch(
    `${DEMO_API_BASE}?action=${encodeURIComponent(action)}`,
    {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    }
  );

  if (!response.ok) {
    throw new Error(`Demo backend responded with ${response.status}`);
  }

  return response.json() as Promise<DemoResponse>;
}

export default function useVercelDemoQueue() {
  const [serverState, setServerState] = useState<QueueResponse>(() =>
    emptyState()
  );
  const [toast, setToast] = useState("");
  const [systemError, setSystemError] = useState<string | null>(null);
  const [busy, setBusyState] = useState<BusyState>(null);
  const busyTimerRef = useRef<number | null>(null);

  const clearBusy = useCallback(() => {
    setBusyState(null);

    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }
  }, []);

  const setBusy = useCallback((value: BusyState) => {
    setBusyState(value);

    if (busyTimerRef.current) {
      window.clearTimeout(busyTimerRef.current);
      busyTimerRef.current = null;
    }

    if (value) {
      busyTimerRef.current = window.setTimeout(() => {
        setBusyState(null);
        busyTimerRef.current = null;
      }, BUSY_TIMEOUT);
    }
  }, []);

  const applyResponse = useCallback(
    (payload: DemoResponse) => {
      setServerState(payload.state ?? emptyState());

      if (payload.toast) {
        setToast(payload.toast);
        window.setTimeout(() => setToast(""), 4500);
      }

      clearBusy();
      setSystemError(null);
    },
    [clearBusy]
  );

  const refreshState = useCallback(async () => {
    try {
      const payload = await requestDemo("state");
      setServerState(payload.state ?? emptyState());
      setSystemError(null);
    } catch (err) {
      console.warn("Demo backend inaccessible", err);
      setSystemError("Serveur hors ligne.");
    }
  }, []);

  useEffect(() => {
    void refreshState();

    const id = window.setInterval(() => {
      void refreshState();
    }, 2500);

    return () => {
      window.clearInterval(id);
    };
  }, [refreshState]);

  useEffect(() => {
    return () => {
      if (busyTimerRef.current) {
        window.clearTimeout(busyTimerRef.current);
      }
    };
  }, []);

  const runAction = useCallback(
    async (
      action: string,
      payload: Record<string, unknown> | undefined,
      busyKey: BusyState
    ) => {
      try {
        if (busyKey) {
          setBusy(busyKey);
        }

        const response = await requestDemo(action, payload);
        applyResponse(response);
      } catch (err) {
        console.warn(`Demo action failed: ${action}`, err);
        clearBusy();
        setToast("Erreur : Serveur hors ligne");
        window.setTimeout(() => setToast(""), 4500);
      }
    },
    [applyResponse, clearBusy, setBusy]
  );

  const play = useCallback(
    (url: string, addedBy?: string) => {
      void runAction(
        "play",
        {
          url,
          addedBy,
          clientRequestId: makeClientRequestId(),
        },
        "play"
      );
    },
    [runAction]
  );

  const command = useCallback(
    (cmd: Command, arg?: number | string) => {
      void runAction("command", { cmd, arg }, cmd);
    },
    [runAction]
  );

  const clear = useCallback(() => {
    void runAction("clear", undefined, "clear");
  }, [runAction]);

  const reorderQueue = useCallback(
    (ids: string[]) => {
      void runAction("reorder_queue", { ids }, "reorder_queue");
    },
    [runAction]
  );

  const removeQueueItem = useCallback(
    (id: string) => {
      void runAction("remove_queue_item", { id }, "remove_queue_item");
    },
    [runAction]
  );

  const requeueHistoryItem = useCallback(
    (id: string, targetIndex?: number) => {
      void runAction(
        "requeue_history_item",
        { id, targetIndex },
        "requeue_history_item"
      );
    },
    [runAction]
  );

  return {
    state: serverState,
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
