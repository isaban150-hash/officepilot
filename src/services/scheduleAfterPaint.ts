/**
 * Run work only after the browser has had a chance to paint.
 * Double rAF, then requestIdleCallback when available, with a hard timer
 * fallback so environments without a working idle callback never hang.
 */
export function scheduleAfterPaint(callback: () => void): () => void {
  let cancelled = false;
  let settled = false;
  let raf1 = 0;
  let raf2 = 0;
  let idleHandle: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (cancelled || settled) return;
    settled = true;
    callback();
  };

  const afterFrames = () => {
    if (cancelled || settled) return;

    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (
          cb: IdleRequestCallback,
          opts?: IdleRequestOptions,
        ) => number;
      }
    ).requestIdleCallback;

    if (typeof ric === 'function') {
      idleHandle = ric(() => run(), { timeout: 120 });
      // Hard fallback: some test/DOM environments never fire idle callbacks.
      timeoutHandle = setTimeout(run, 160);
      return;
    }

    timeoutHandle = setTimeout(run, 0);
  };

  if (typeof requestAnimationFrame === 'function') {
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(afterFrames);
    });
  } else {
    timeoutHandle = setTimeout(afterFrames, 32);
  }

  return () => {
    cancelled = true;
    if (raf1) cancelAnimationFrame(raf1);
    if (raf2) cancelAnimationFrame(raf2);
    const cic = (
      globalThis as unknown as { cancelIdleCallback?: (id: number) => void }
    ).cancelIdleCallback;
    if (idleHandle != null && typeof cic === 'function') {
      cic(idleHandle);
    }
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }
  };
}
