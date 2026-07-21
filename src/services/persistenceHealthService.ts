export type PersistenceHealthSnapshot = {
  /** True when the last persistAll completed successfully. */
  healthy: boolean;
  hasFailure: boolean;
};

type Listener = (snapshot: PersistenceHealthSnapshot) => void;

const listeners = new Set<Listener>();

let cached: PersistenceHealthSnapshot = {
  healthy: true,
  hasFailure: false,
};

/** Called from persistAll after updating lastPersistSuccess / lastPersistFailure. */
export function notifyPersistenceHealthChanged(snapshot: PersistenceHealthSnapshot): void {
  cached = { ...snapshot };
  for (const listener of listeners) {
    try {
      listener(cached);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function getPersistenceHealthSnapshot(): PersistenceHealthSnapshot {
  return cached;
}

export function subscribePersistenceHealth(listener: Listener): () => void {
  listeners.add(listener);
  listener(cached);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPersistenceHealthForTests(): void {
  cached = { healthy: true, hasFailure: false };
  listeners.clear();
}
