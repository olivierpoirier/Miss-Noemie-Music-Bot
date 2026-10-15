import type { QueueResponse } from "../types";

export type DemoResponse = {
  ok: boolean;
  state: QueueResponse;
  toast?: string;
};

export const DEMO_REQUEST_TIMEOUT = 20_000;

export async function requestDemo(
  action: string,
  payload?: Record<string, unknown>,
  options: { baseUrl?: string; signal?: AbortSignal } = {}
): Promise<DemoResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, DEMO_REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${options.baseUrl || "/api/demo"}?action=${encodeURIComponent(action)}`,
      {
        method: action === "state" ? "GET" : "POST",
        headers: action !== "state" ? { "Content-Type": "application/json" } : undefined,
        body: action !== "state" ? JSON.stringify(payload ?? {}) : undefined,
        cache: "no-store",
        signal: controller.signal,
      }
    );
    const result = await response.json() as DemoResponse;
    if (!response.ok || !result.ok) {
      throw new Error(result.toast || `Erreur du serveur (${response.status}).`);
    }
    if (!result.state || !Array.isArray(result.state.queue)) {
      throw new Error("Réponse du serveur invalide.");
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("Le serveur met trop de temps à répondre. Réessaie dans un instant.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
