// Optional services such as public tunnels must not stop local audio when they
// exit. Keep one retry timer and cap its delay even after repeated failures.
export function startRestartingProcess(start, {
  onRetry = () => {},
  initialDelayMs = 1_000,
  maxDelayMs = 30_000,
  stableAfterMs = 60_000,
} = {}) {
  let stopped = false;
  let timer = null;
  let delayMs = initialDelayMs;
  let detach = () => {};

  const launch = () => {
    if (stopped) return;
    const startedAt = Date.now();
    let finished = false;
    const retry = () => {
      if (finished || stopped) return;
      finished = true;
      detach();
      if (Date.now() - startedAt >= stableAfterMs) delayMs = initialDelayMs;
      const wait = delayMs;
      delayMs = Math.min(maxDelayMs, delayMs * 2);
      onRetry(wait);
      timer = setTimeout(() => {
        timer = null;
        launch();
      }, wait);
    };

    try {
      const child = start();
      const onError = () => retry();
      const onExit = () => retry();
      child.once("error", onError);
      child.once("exit", onExit);
      detach = () => {
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
      };
    } catch {
      retry();
    }
  };

  launch();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    detach();
  };
}
