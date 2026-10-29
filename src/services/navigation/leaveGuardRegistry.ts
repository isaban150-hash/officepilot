/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27, X-01/X-02) — Verlassen-Schutz: welche Formulare ungespeicherte Änderungen haben.
 *
 * Formulare melden sich mit `useLeaveGuard` an; der Wächter in der App (`LeaveGuardHost`) fragt bei Navigation über
 * App-Links und Menüs, Browser-Zurück und -Vor sowie — über `confirmLeaveIfDirty` — vor Abmelden und Betriebswechsel
 * nach. Neuladen und Schließen deckt `beforeunload` ab (Rückfrage des Browsers). Die Auskunft ist synchron, damit eine
 * Navigation unmittelbar nach dem Speichern keine Rückfrage auslöst (`release` vor dem Navigieren).
 */
interface LeaveGuardEntry {
  dirty: boolean;
  /** Bleibt ein Entwurf erhalten (Wiederaufnahme), oder gehen die Eingaben verloren? */
  draftKept: boolean;
}

const guards = new Map<number, LeaveGuardEntry>();
const listeners = new Set<() => void>();
let nextId = 1;
let version = 0;
let confirmer: (() => Promise<boolean>) | null = null;

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

export interface LeaveGuardHandle {
  update(dirty: boolean, draftKept: boolean): void;
  /** Sofort sauber (etwa unmittelbar vor einer Navigation nach erfolgreichem Speichern). */
  release(): void;
  dispose(): void;
}

export function registerLeaveGuard(): LeaveGuardHandle {
  const id = nextId++;
  guards.set(id, { dirty: false, draftKept: false });
  return {
    update(dirty, draftKept) {
      const before = guards.get(id);
      if (!before || (before.dirty === dirty && before.draftKept === draftKept)) return;
      guards.set(id, { dirty, draftKept });
      notify();
    },
    release() {
      const before = guards.get(id);
      if (!before || !before.dirty) return;
      guards.set(id, { ...before, dirty: false });
      notify();
    },
    dispose() {
      if (guards.delete(id)) notify();
    },
  };
}

export function hasDirtyLeaveGuard(): boolean {
  for (const entry of guards.values()) if (entry.dirty) return true;
  return false;
}

/** Nur wenn jedes geänderte Formular einen Entwurf behält, sagt die Rückfrage „bleibt als Entwurf erhalten“. */
export function dirtyGuardsKeepDrafts(): boolean {
  let any = false;
  for (const entry of guards.values()) {
    if (!entry.dirty) continue;
    any = true;
    if (!entry.draftKept) return false;
  }
  return any;
}

export function subscribeLeaveGuards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLeaveGuardVersion(): number {
  return version;
}

/** Der Wächter stellt die Rückfrage bereit; ohne Wächter (etwa in Komponententests) gibt es keine Sperre. */
export function setLeaveConfirmer(next: (() => Promise<boolean>) | null): void {
  confirmer = next;
}

/** Vor Abmelden und Betriebswechsel: `true` = weiter, `false` = bleiben. */
export async function confirmLeaveIfDirty(): Promise<boolean> {
  if (!hasDirtyLeaveGuard() || !confirmer) return true;
  return confirmer();
}

export function resetLeaveGuardsForTests(): void {
  guards.clear();
  confirmer = null;
  notify();
}
