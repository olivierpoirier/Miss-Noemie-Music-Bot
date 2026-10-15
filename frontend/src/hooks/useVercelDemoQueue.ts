import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, QueueResponse } from "../types";
import useQueueFeedback, { type BusyState } from "./useQueueFeedback";
import { requestDemo, DEMO_REQUEST_TIMEOUT } from "../lib/demo-api";

const DEMO_API_BASE = import.meta.env.VITE_DEMO_API_BASE || "/api/demo";
const POLL_INTERVAL = 2500;

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

export default function useVercelDemoQueue() {
  const [serverState, setServerState] = useState<QueueResponse>(emptyState);
  const feedback = useQueueFeedback(DEMO_REQUEST_TIMEOUT + 1000);
  const { setToast, setSystemError, setBusy, clearBusy } = feedback;
  const mountedRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const versionRef = useRef(0);
  const pendingActionsRef = useRef(0);
  const actionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const playInFlightRef = useRef(false);

  const request = useCallback(async (
    action: string,
    payload?: Record<string, unknown>
  ) => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      return await requestDemo(action, payload, { baseUrl: DEMO_API_BASE, signal: controller.signal });
    } finally {
      controllersRef.current.delete(controller);
    }
  }, []);

  const refreshState = useCallback(async () => {
    if (pendingActionsRef.current > 0) return;
    const version = versionRef.current;
    try {
      const payload = await request("state");
      // A poll started before a command must not restore its stale snapshot.
      if (!mountedRef.current || version !== versionRef.current) return;
      setServerState(payload.state);
      setSystemError(null);
    } catch (err) {
      if (!mountedRef.current || version !== versionRef.current) return;
      console.warn("Demo backend inaccessible", err);
      setSystemError("Serveur hors ligne. Reconnexion automatique…");
    }
  }, [request, setSystemError]);

  useEffect(() => {
    mountedRef.current = true;
    let timer: number;
    let cancelled = false;
    const poll = async () => {
      await refreshState();
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_INTERVAL);
    };
    void poll();
    const controllers = controllersRef.current;
    return () => {
      cancelled = true;
      mountedRef.current = false;
      versionRef.current += 1;
      window.clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    };
  }, [refreshState]);

  const runAction = useCallback((
    action: string,
    payload: Record<string, unknown> | undefined,
    busyKey: BusyState
  ) => {
    versionRef.current += 1;
    pendingActionsRef.current += 1;
    // Preserve click order and avoid racing command responses with each other
    // or with the background poll.
    const task = actionQueueRef.current.then(async () => {
      if (!mountedRef.current) return;
      setBusy(busyKey);
      try {
        const response = await request(action, payload);
        if (!mountedRef.current) return;
        setServerState(response.state);
        if (response.toast) setToast(response.toast);
        setSystemError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        console.warn(`Demo action failed: ${action}`, err);
        setToast(err instanceof Error ? err.message : "Serveur hors ligne.");
      } finally {
        if (mountedRef.current) clearBusy();
      }
    }).finally(() => {
      pendingActionsRef.current -= 1;
    });
    actionQueueRef.current = task;
    return task;
  }, [clearBusy, request, setBusy, setSystemError, setToast]);

  const play = useCallback((url: string, addedBy?: string) => {
    if (playInFlightRef.current) return false;
    playInFlightRef.current = true;
    const clientRequestId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    void runAction("play", { url, addedBy, clientRequestId }, "play").finally(() => {
      playInFlightRef.current = false;
    });
    return true;
  }, [runAction]);

  const command = useCallback((cmd: Command, arg?: number | string) => {
    void runAction("command", { cmd, arg }, cmd);
  }, [runAction]);

  const clear = useCallback(() => {
    void runAction("clear", undefined, "clear");
  }, [runAction]);

  const reorderQueue = useCallback((ids: string[]) => {
    void runAction("reorder_queue", { ids }, "reorder_queue");
  }, [runAction]);

  const removeQueueItem = useCallback((id: string) => {
    void runAction("remove_queue_item", { id }, "remove_queue_item");
  }, [runAction]);

  const requeueHistoryItem = useCallback((id: string, targetIndex?: number) => {
    void runAction("requeue_history_item", { id, targetIndex }, "requeue_history_item");
  }, [runAction]);

  return { state: serverState, ...feedback, play, command, clear, reorderQueue, removeQueueItem, requeueHistoryItem };
}
