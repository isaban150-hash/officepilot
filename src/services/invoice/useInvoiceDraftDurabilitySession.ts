/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P3 / 01P3A — Sitzung für
 * Initialisierung, Wiederherstellung und sofortiges Autosave von
 * Rechnungsentwürfen.
 *
 * Grundsätze:
 *  - `mutateDraft` ist der einzige Änderungsweg; es gibt keinen Zustand, in
 *    dem der Entwurf bearbeitbar ist, ohne durch den dauerhaften Speicherweg
 *    zu laufen.
 *  - **Jede Locator-Generation besitzt ihre eigene Warteschlange** mit eigenem
 *    `saving`, eigenem wartenden Snapshot und eigenen Flush-Wartenden. Ein
 *    Ergebnis einer alten Generation kann die neue Sitzung nicht berühren —
 *    auch nicht über ein `finally`.
 *  - Die Revision stammt ausschließlich aus einem erfolgreichen Kernergebnis.
 *    Keine optimistische Revision, kein Last-Write-Wins.
 *  - Keine Lifecycle-Ereignisse: die Haltbarkeit entsteht allein aus sofort
 *    gestarteten IndexedDB-Transaktionen.
 *
 * Ehrliches Verlustfenster: Jeder vom Kerndienst bestätigte Stand ist auf
 * demselben Gerät, im selben Browser und unter derselben Origin dauerhaft
 * gespeichert. Die neueste noch nicht bestätigte Änderung kann bei einem
 * plötzlichen Prozessende verloren gehen; die Dauer hängt von Gerät, Browser
 * und Speicherzustand ab und besitzt keine garantierte Obergrenze. Deshalb
 * bleibt `saving` sichtbar von `saved` unterscheidbar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import type {
  InvoiceDraftIdentity,
  InvoiceDraftLocator,
  InvoiceDraftRecord,
} from '../../types/invoiceDraftDurability';
import type { InvoiceDraft } from '../../types/models';

export type InvoiceDraftSessionStatus =
  | 'idle'
  | 'loading'
  | 'creating'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'finalization_pending'
  | 'already_finalized'
  | 'blocked_no_identity'
  | 'blocked_conflict'
  | 'blocked_storage'
  | 'disposed';

export type InvoiceDraftFlushOutcome =
  | 'saved'
  | 'no_changes'
  | 'conflict'
  | 'storage_error'
  | 'read_only'
  | 'disposed';

export interface InvoiceDraftFlushResult {
  ok: boolean;
  outcome: InvoiceDraftFlushOutcome;
}

/** Typisierter Befund für die Oberfläche — nie ein technisches Error-Objekt. */
export interface InvoiceDraftSessionIssue {
  kind: 'identity' | 'storage' | 'conflict';
  reason: string;
  currentRevision?: number;
}

/** Schmaler Adapter — Produktionsstandard sind die echten Kernfunktionen. */
export interface InvoiceDraftDurabilityAdapter {
  loadByLocator: typeof loadInvoiceDraftRecordByLocator;
  create: typeof createInvoiceDraftRecord;
  save: typeof saveInvoiceDraftRecord;
}

export const defaultInvoiceDraftDurabilityAdapter: InvoiceDraftDurabilityAdapter = {
  loadByLocator: loadInvoiceDraftRecordByLocator,
  create: createInvoiceDraftRecord,
  save: saveInvoiceDraftRecord,
};

export interface InvoiceDraftDurabilitySessionInput {
  locator: InvoiceDraftLocator | null;
  createDraft: () => InvoiceDraft | null;
  adapter?: InvoiceDraftDurabilityAdapter;
  now?: () => string;
}

export interface InvoiceDraftDurabilitySession {
  draft: InvoiceDraft | null;
  record: InvoiceDraftRecord | null;
  status: InvoiceDraftSessionStatus;
  readOnly: boolean;
  blocked: boolean;
  restored: boolean;
  issue: InvoiceDraftSessionIssue | null;
  mutateDraft: (updater: (prev: InvoiceDraft) => InvoiceDraft) => void;
  flush: () => Promise<InvoiceDraftFlushResult>;
}

const EDITABLE: InvoiceDraftSessionStatus[] = ['ready', 'saving', 'saved'];
const BLOCKED: InvoiceDraftSessionStatus[] = [
  'blocked_no_identity',
  'blocked_conflict',
  'blocked_storage',
];

function locatorKeyOf(locator: InvoiceDraftLocator | null): string | null {
  if (!locator) return null;
  return JSON.stringify([
    locator.sourceScopeKey,
    locator.workspaceId,
    locator.vorgangId,
    locator.invoiceType,
  ]);
}

interface SessionView {
  sessionId: number;
  status: InvoiceDraftSessionStatus;
  draft: InvoiceDraft | null;
  record: InvoiceDraftRecord | null;
  restored: boolean;
  issue: InvoiceDraftSessionIssue | null;
}

const INITIAL_VIEW: SessionView = {
  sessionId: 0,
  status: 'idle',
  draft: null,
  record: null,
  restored: false,
  issue: null,
};

/**
 * Eine Warteschlangensitzung gehört genau einer Locator-Generation. Sie wird
 * beim Wechsel als inaktiv markiert und nie wiederbelebt.
 */
/**
 * Verlustfreie Abtrennung: `InvoiceDraft` wird ohnehin als vollständiger
 * JSON-Rohtext gespeichert, deshalb ist eine JSON-Klonung für genau dieses
 * Datenmodell zulässig und vollständig.
 */
function cloneDraft(draft: InvoiceDraft): InvoiceDraft {
  return JSON.parse(JSON.stringify(draft)) as InvoiceDraft;
}

const IDENTITY_REASONS = new Set([
  'missing_locator',
  'invalid_identity',
  'identity_mismatch',
]);

function classifyIssue(reason: string, currentRevision?: number): InvoiceDraftSessionIssue {
  const kind: InvoiceDraftSessionIssue['kind'] = IDENTITY_REASONS.has(reason)
    ? 'identity'
    : reason === 'conflict'
      ? 'conflict'
      : 'storage';
  return { kind, reason, ...(currentRevision !== undefined ? { currentRevision } : {}) };
}

interface QueueSession {
  generation: number;
  /** Der Locator, für den diese Sitzung erzeugt wurde. */
  locatorKey: string | null;
  active: boolean;
  saving: boolean;
  pendingSnapshot: InvoiceDraft | null;
  waiters: ((result: InvoiceDraftFlushResult) => void)[];
  terminalOutcome: InvoiceDraftFlushOutcome | null;
  identity: InvoiceDraftIdentity | null;
  revision: number;
  /** Interner Stand — wird niemals nach außen gegeben. */
  draft: InvoiceDraft | null;
  /** Vollständiger Rohtext des internen Standes für den Inhaltsvergleich. */
  draftText: string | null;
  status: InvoiceDraftSessionStatus;
  /** Wird vom Initialisierungseffekt gesetzt und gehört nur dieser Sitzung. */
  runQueue?: () => Promise<void>;
}

export function useInvoiceDraftDurabilitySession(
  input: InvoiceDraftDurabilitySessionInput,
): InvoiceDraftDurabilitySession {
  const [view, setView] = useState<SessionView>(INITIAL_VIEW);
  const [session, setSession] = useState<QueueSession | null>(null);

  const adapterRef = useRef(input.adapter ?? defaultInvoiceDraftDurabilityAdapter);
  adapterRef.current = input.adapter ?? defaultInvoiceDraftDurabilityAdapter;
  const createDraftRef = useRef(input.createDraft);
  createDraftRef.current = input.createDraft;
  const nowRef = useRef(input.now);
  nowRef.current = input.now;
  const locatorRef = useRef(input.locator);
  locatorRef.current = input.locator;
  const generationCounterRef = useRef(0);

  const locatorKey = locatorKeyOf(input.locator);
  /** Schon im Render aktuell — die Sperre wartet nicht auf useEffect. */
  const locatorKeyRef = useRef(locatorKey);
  locatorKeyRef.current = locatorKey;
  /** Eindeutiger Nachweis der aktuellen Sitzung für eingeplante Updates. */
  const currentSessionRef = useRef<QueueSession | null>(null);

  useEffect(() => {
    const queue: QueueSession = {
      generation: (generationCounterRef.current += 1),
      locatorKey: locatorKeyRef.current,
      active: true,
      saving: false,
      pendingSnapshot: null,
      waiters: [],
      terminalOutcome: null,
      identity: null,
      revision: 0,
      draft: null,
      draftText: null,
      status: 'idle',
    };
    currentSessionRef.current = queue;
    setSession(queue);

    /**
     * Nur die aktive **und** aktuelle Sitzung darf die Anzeige verändern — die
     * Prüfung wiederholt sich im funktionalen Updater, damit ein bereits
     * eingeplantes Update einer alten Generation keinen neueren View
     * überschreibt.
     */
    const applyView = (patch: Partial<Omit<SessionView, 'sessionId'>>) => {
      if (!queue.active || currentSessionRef.current !== queue) return;
      if (patch.status !== undefined) queue.status = patch.status;
      setView((prev) => {
        if (!queue.active || currentSessionRef.current !== queue) return prev;
        return { ...prev, ...patch, sessionId: queue.generation };
      });
    };

    const resolveWaiters = (outcome?: InvoiceDraftFlushOutcome) => {
      const waiters = queue.waiters;
      if (waiters.length === 0) return;
      queue.waiters = [];
      const resolved: InvoiceDraftFlushOutcome =
        outcome ??
        (!queue.active
          ? 'disposed'
          : queue.status === 'blocked_conflict'
            ? 'conflict'
            : queue.status === 'blocked_storage'
              ? 'storage_error'
              : 'saved');
      for (const waiter of waiters) {
        waiter({ ok: resolved === 'saved' || resolved === 'no_changes', outcome: resolved });
      }
    };
    queue.terminalOutcome = null;

    const blockStorage = (reason: string) => {
      applyView({ status: 'blocked_storage', issue: classifyIssue(reason) });
      queue.pendingSnapshot = null;
      resolveWaiters('storage_error');
    };

    const nowValue = (): string | null => {
      try {
        return nowRef.current ? nowRef.current() : new Date().toISOString();
      } catch {
        return null;
      }
    };

    /**
     * Serialisierte Warteschlange **dieser** Generation. Ein alter Aufruf
     * berührt weder `saving`, noch Wartende, noch den Status der neuen Sitzung.
     */
    const runQueue = async (): Promise<void> => {
      if (queue.saving || !queue.active) return;
      queue.saving = true;
      try {
        while (
          queue.active &&
          queue.pendingSnapshot &&
          EDITABLE.includes(queue.status) &&
          queue.identity
        ) {
          const snapshot = queue.pendingSnapshot;
          queue.pendingSnapshot = null;
          const stamp = nowValue();
          if (stamp === null) {
            blockStorage('now_failed');
            return;
          }

          let result: Awaited<ReturnType<typeof saveInvoiceDraftRecord>>;
          try {
            result = await adapterRef.current.save({
              identity: queue.identity,
              draft: snapshot,
              expectedRevision: queue.revision,
              now: stamp,
            });
          } catch {
            if (!queue.active) return;
            blockStorage('save_threw');
            return;
          }

          if (!queue.active) return;

          if (result.ok) {
            queue.revision = result.record.revision;
            applyView({ record: result.record });
            if (!queue.pendingSnapshot) applyView({ status: 'saved' });
            continue;
          }

          queue.pendingSnapshot = null;
          if (result.reason === 'conflict') {
            applyView({
              status: 'blocked_conflict',
              issue: classifyIssue(result.reason, result.currentRevision),
            });
          } else {
            applyView({ status: 'blocked_storage', issue: classifyIssue(result.reason) });
          }
          return;
        }
      } finally {
        // Ausschließlich die eigene Sitzung.
        queue.saving = false;
        resolveWaiters();
      }
    };
    queue.runQueue = runQueue;

    const adopt = (record: InvoiceDraftRecord, draft: InvoiceDraft, restored: boolean) => {
      queue.identity = {
        sourceScopeKey: record.sourceScopeKey,
        workspaceId: record.workspaceId,
        vorgangId: record.vorgangId,
        invoiceType: record.invoiceType,
        draftId: record.draftId,
      };
      queue.revision = record.revision;
      // Interner und sichtbarer Stand sind getrennte Instanzen.
      queue.draft = cloneDraft(draft);
      queue.draftText = JSON.stringify(queue.draft);
      const status: InvoiceDraftSessionStatus =
        record.status === 'active'
          ? 'ready'
          : record.status === 'finalizing'
            ? 'finalization_pending'
            : 'already_finalized';
      applyView({ status, draft: cloneDraft(queue.draft), record, restored, issue: null });
    };

    const locator = locatorRef.current;
    if (!locator) {
      // Ohne Identität: kein Datenbankaufruf, kein createDraft, nichts editierbar.
      applyView({
        status: 'blocked_no_identity',
        draft: null,
        record: null,
        restored: false,
        issue: classifyIssue('missing_locator'),
      });
      return () => {
        queue.active = false;
        queue.pendingSnapshot = null;
        resolveWaiters('disposed');
      };
    }

    applyView({ status: 'loading', draft: null, record: null, restored: false, issue: null });

    void (async () => {
      const adapter = adapterRef.current;

      let loaded: Awaited<ReturnType<typeof loadInvoiceDraftRecordByLocator>>;
      try {
        loaded = await adapter.loadByLocator(locator);
      } catch {
        if (queue.active) blockStorage('load_threw');
        return;
      }
      if (!queue.active) return;

      if (loaded.ok) {
        adopt(loaded.record, loaded.draft, true);
        return;
      }
      if (loaded.reason !== 'not_found') {
        // corrupt, identity_mismatch, unsupported_format, Speicherfehler:
        // nichts ersetzen, nichts löschen, kein createDraft als Rückfall.
        blockStorage(loaded.reason);
        return;
      }

      applyView({ status: 'creating' });
      let fresh: InvoiceDraft | null;
      try {
        fresh = createDraftRef.current();
      } catch {
        if (queue.active) blockStorage('create_draft_threw');
        return;
      }
      if (!queue.active) return;
      if (!fresh) {
        blockStorage('create_draft_empty');
        return;
      }

      const stamp = nowValue();
      if (stamp === null) {
        blockStorage('now_failed');
        return;
      }

      const identity: InvoiceDraftIdentity = { ...locator, draftId: fresh.id };
      let created: Awaited<ReturnType<typeof createInvoiceDraftRecord>>;
      try {
        created = await adapter.create({ identity, draft: fresh, now: stamp });
      } catch {
        if (queue.active) blockStorage('create_threw');
        return;
      }
      if (!queue.active) return;

      if (created.ok) {
        adopt(created.record, fresh, false);
        return;
      }
      if (created.reason !== 'already_exists') {
        blockStorage(created.reason);
        return;
      }

      // Ein anderer Vorgang war schneller: der dauerhafte Gewinner gilt.
      let winner: Awaited<ReturnType<typeof loadInvoiceDraftRecordByLocator>>;
      try {
        winner = await adapter.loadByLocator(locator);
      } catch {
        if (queue.active) blockStorage('load_threw');
        return;
      }
      if (!queue.active) return;
      if (winner.ok) {
        adopt(winner.record, winner.draft, true);
        return;
      }
      blockStorage(winner.reason);
    })();

    return () => {
      /**
       * Locatorwechsel, StrictMode-Cleanup oder Unmount: diese Sitzung ist
       * beendet. Ein bereits gestarteter Schreibvorgang kann technisch noch
       * für seine alte, korrekt gebundene Identität abschließen — er wirkt
       * aber nie mehr auf die Anzeige oder auf eine neue Sitzung.
       */
      queue.active = false;
      queue.pendingSnapshot = null;
      queue.terminalOutcome = 'disposed';
      resolveWaiters('disposed');
    };
  }, [locatorKey]);

  /** Callbacks sind an genau die Sitzung gebunden, aus der sie stammen. */
  const callbacks = useMemo(() => {
    const queue = session;

    /** Die Sitzung muss aktiv **und** die des aktuell gerenderten Locators sein. */
    const usable = (): boolean =>
      Boolean(queue) && queue!.active && queue!.locatorKey === locatorKeyRef.current;

    const mutateDraft = (updater: (prev: InvoiceDraft) => InvoiceDraft): void => {
      if (!queue || !usable()) return;
      if (!EDITABLE.includes(queue.status)) return;
      const previous = queue.draft;
      const previousText = queue.draftText;
      if (!previous || !previousText || !queue.identity) return;

      let next: InvoiceDraft;
      try {
        // Der Updater erhält niemals das intern gehaltene Objekt.
        next = updater(cloneDraft(previous));
      } catch {
        // Ein geworfener Updater darf die Sitzungssteuerung nicht zerstören;
        // der vorherige Stand bleibt vollständig unverändert.
        queue.status = 'blocked_storage';
        queue.pendingSnapshot = null;
        setView((prev) =>
          prev.sessionId === queue.generation
            ? { ...prev, status: 'blocked_storage', issue: classifyIssue('updater_threw') }
            : prev,
        );
        const waiters = queue.waiters;
        queue.waiters = [];
        for (const waiter of waiters) waiter({ ok: false, outcome: 'storage_error' });
        return;
      }
      if (!next) return;

      // Inhaltsvergleich statt Referenzvergleich — der Kandidat ist abgetrennt.
      let nextText: string;
      try {
        nextText = JSON.stringify(next);
      } catch {
        queue.status = 'blocked_storage';
        queue.pendingSnapshot = null;
        setView((prev) =>
          prev.sessionId === queue.generation
            ? { ...prev, status: 'blocked_storage', issue: classifyIssue('serialize_failed') }
            : prev,
        );
        return;
      }
      if (nextText === previousText) return;

      const internal = JSON.parse(nextText) as InvoiceDraft;
      const visible = JSON.parse(nextText) as InvoiceDraft;
      queue.status = 'saving';
      queue.draft = internal;
      queue.draftText = nextText;
      queue.pendingSnapshot = internal;
      setView((prev) =>
        prev.sessionId === queue.generation
          ? { ...prev, draft: visible, status: 'saving', restored: false }
          : prev,
      );
      void queue.runQueue?.();
    };

    const flush = async (): Promise<InvoiceDraftFlushResult> => {
      if (!queue || !usable()) return { ok: false, outcome: 'disposed' };
      if (queue.status === 'blocked_conflict') return { ok: false, outcome: 'conflict' };
      if (queue.status === 'blocked_storage') return { ok: false, outcome: 'storage_error' };
      if (!EDITABLE.includes(queue.status)) return { ok: false, outcome: 'read_only' };
      if (!queue.saving && !queue.pendingSnapshot) return { ok: true, outcome: 'no_changes' };
      return new Promise<InvoiceDraftFlushResult>((resolve) => {
        queue.waiters.push(resolve);
      });
    };

    return { mutateDraft, flush };
  }, [session, locatorKey]);

  /**
   * Synchrone Locator-Sperre: ein Locatorwechsel ist bereits im Render
   * sichtbar, der passive Effect läuft erst danach. Solange Sitzung, View und
   * aktueller Locator nicht zusammenpassen, werden weder Entwurf noch
   * Datensatz der alten Sitzung ausgegeben.
   */
  const stale =
    !session || session.locatorKey !== locatorKey || view.sessionId !== session.generation;

  if (stale) {
    const status: InvoiceDraftSessionStatus =
      locatorKey === null ? 'blocked_no_identity' : 'loading';
    return {
      draft: null,
      record: null,
      status,
      readOnly: true,
      blocked: locatorKey === null,
      restored: false,
      issue: locatorKey === null ? classifyIssue('missing_locator') : null,
      mutateDraft: callbacks.mutateDraft,
      flush: callbacks.flush,
    };
  }

  return {
    draft: view.draft,
    record: view.record,
    status: view.status,
    readOnly: !EDITABLE.includes(view.status),
    blocked: BLOCKED.includes(view.status),
    restored: view.restored,
    issue: view.issue,
    mutateDraft: callbacks.mutateDraft,
    flush: callbacks.flush,
  };
}
