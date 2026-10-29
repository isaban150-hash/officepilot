/**
 * EINRICHTUNG-01 (AP2; A-01.4, A-02.3, N-A2.5; Vertrag 1.11) — läuft die App gerade auf unbestätigten Rechten?
 *
 * Das ist der Fall, solange das Profil nur aus dem Zwischenspeicher stammt (Profilabruf gescheitert) oder die App
 * offline mit dem kontogebundenen Bestand gestartet ist. Lokale Änderungen bleiben möglich („lokal gespeichert, nicht
 * bestätigt“); cloudbestätigte Aktionen — Finanz, Versand, Team — bietet die Oberfläche dann nicht an: Die Rechte dafür
 * kämen nur aus dem Cache.
 *
 * Bewusst ein ausdrückliches Kennzeichen der beiden eingeschränkten Wege und kein Ausgangsverbot: Der Server
 * entscheidet ohnehin bei jeder Aktion neu (Vertrag 1.1).
 */
export type CloudRightsUnconfirmedReason = 'profile_unconfirmed' | 'offline_start';

const unbestaetigt = new Map<string, Set<CloudRightsUnconfirmedReason>>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Ein Zuhörer darf die anderen nicht aufhalten.
    }
  }
}

export function markCloudRightsUnconfirmed(userId: string | null | undefined, reason: CloudRightsUnconfirmedReason): void {
  if (!userId) return;
  const gruende = unbestaetigt.get(userId) ?? new Set<CloudRightsUnconfirmedReason>();
  if (gruende.has(reason)) return;
  gruende.add(reason);
  unbestaetigt.set(userId, gruende);
  notify();
}

/** Ein Grund ist erledigt (Profil bestätigt bzw. Betrieb online bestätigt). */
export function markCloudRightsConfirmed(userId: string | null | undefined, reason: CloudRightsUnconfirmedReason): void {
  if (!userId) return;
  const gruende = unbestaetigt.get(userId);
  if (!gruende?.delete(reason)) return;
  if (gruende.size === 0) unbestaetigt.delete(userId);
  notify();
}

export function isCloudRightsUnconfirmed(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return (unbestaetigt.get(userId)?.size ?? 0) > 0;
}

/** Beim Abmelden oder Kontowechsel: Kein Kennzeichen überdauert das Konto. */
export function clearCloudRightsState(userId?: string | null): void {
  if (userId) {
    if (unbestaetigt.delete(userId)) notify();
    return;
  }
  if (unbestaetigt.size === 0) return;
  unbestaetigt.clear();
  notify();
}

export function subscribeCloudRightsState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCloudRightsStateVersion(): number {
  return version;
}
