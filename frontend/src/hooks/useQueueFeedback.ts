import { useCallback, useEffect, useRef, useState } from "react";
import type { Command } from "../types";

export type BusyState =
  | Command
  | "play"
  | "clear"
  | "reorder_queue"
  | "remove_queue_item"
  | "requeue_history_item"
  | null;

// Both transports share the same busy and notification lifecycle. Toast owns
// its display timer, so an older notification cannot clear a newer message.
export default function useQueueFeedback(timeoutMs: number) {
  const [toast, setToast] = useState("");
  const [systemError, setSystemError] = useState<string | null>(null);
  const [busy, setBusyState] = useState<BusyState>(null);
  const busyRef = useRef<BusyState>(null);
  const busyTimerRef = useRef<number | null>(null);

  const setBusy = useCallback((value: BusyState, timeout = timeoutMs) => {
    if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current);
    busyTimerRef.current = null;
    busyRef.current = value;
    setBusyState(value);

    if (value !== null) {
      busyTimerRef.current = window.setTimeout(() => {
        busyTimerRef.current = null;
        busyRef.current = null;
        setBusyState(null);
      }, timeout);
    }
  }, [timeoutMs]);

  const clearBusy = useCallback(() => setBusy(null), [setBusy]);

  useEffect(() => () => {
    if (busyTimerRef.current !== null) window.clearTimeout(busyTimerRef.current);
  }, []);

  return { toast, setToast, systemError, setSystemError, busy, busyRef, setBusy, clearBusy };
}
