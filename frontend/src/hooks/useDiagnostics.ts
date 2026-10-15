import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/api";
import {
  DIAGNOSTIC_POLL_INTERVAL,
  requestDiagnostics,
  type DiagnosticSnapshot,
} from "../lib/diagnostics";
import { IS_VERCEL_DEMO, SOCKET_SERVER_URL } from "../lib/runtime";

const DIAGNOSTIC_BASE = API_BASE || SOCKET_SERVER_URL.replace(/^ws:/, "http:").replace(/^wss:/, "https:");

export default function useDiagnostics(open: boolean) {
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open || IS_VERCEL_DEMO) return;
    let cancelled = false;
    let timer: number | undefined;
    let active: AbortController | null = null;

    const load = async () => {
      if (cancelled || document.hidden || active) return;
      window.clearTimeout(timer);
      const controller = new AbortController();
      active = controller;
      setLoading(true);
      try {
        const next = await requestDiagnostics({ baseUrl: DIAGNOSTIC_BASE, signal: controller.signal });
        if (!cancelled && !controller.signal.aborted) {
          setSnapshot(next);
          setError(null);
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setError(error instanceof Error ? error.message : "Impossible de joindre le serveur.");
        }
      } finally {
        if (!cancelled && active === controller) {
          active = null;
          setLoading(false);
          if (!document.hidden) timer = window.setTimeout(() => void load(), DIAGNOSTIC_POLL_INTERVAL);
        }
      }
    };

    const refresh = () => { void load(); };
    const visibilityChanged = () => {
      window.clearTimeout(timer);
      if (document.hidden) {
        active?.abort();
        active = null;
        setLoading(false);
      } else {
        refresh();
      }
    };
    refreshRef.current = refresh;
    document.addEventListener("visibilitychange", visibilityChanged);
    refresh();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      active?.abort();
      refreshRef.current = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [open]);

  const refresh = useCallback(() => refreshRef.current?.(), []);
  return { snapshot, error, loading: open && loading, refresh, demo: IS_VERCEL_DEMO };
}
