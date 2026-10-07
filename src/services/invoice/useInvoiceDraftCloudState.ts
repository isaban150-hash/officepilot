/**
 * CLOUD-SYNC S5 — der Cloud-Zustand eines geöffneten Rechnungsentwurfs, für
 * beide Rechnungseditoren gleich.
 *
 * Er gleicht beim Öffnen und nach jedem Abzug den lokalen Entwurf mit dem
 * Workspace-Spiegel ab (`reconcileInvoiceDraftOnOpen`), übernimmt eine neuere
 * Cloud-Fassung nur, wenn lokal nichts verändert wurde, und macht jeden anderen
 * Fall als Konflikt sichtbar. Solange ein Konflikt offen ist, nimmt der Editor
 * keine Änderung an — eine Entscheidung darf nicht von weiteren Eingaben
 * überholt werden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftCloudConflict } from '../../types/invoiceDraftCloud';
import { subscribeLocalMutations } from '../persistenceService';
import { subscribeSyncOutbox } from '../sync/syncOutboxService';
import { subscribeAutomaticSyncStatus } from '../sync/syncSchedulerRuntime';
import type { InvoiceDraftDurabilitySession } from './useInvoiceDraftDurabilitySession';
import {
  acceptCloudDraftEnd,
  adoptSlotOwnerDraft,
  continueDraftAsNew,
  discardInvoiceDraft,
  flushInvoiceDraftCloudMirror,
  getInvoiceDraftCloudConflict,
  getInvoiceDraftCloudWatchKey,
  isInvoiceDraftCloudSyncAllowed,
  keepLocalDraftVersion,
  keepOwnDraftDiscardSlotOwner,
  reconcileInvoiceDraftOnOpen,
  takeCloudDraftVersion,
  type InvoiceDraftCloudDecisionResult,
} from './invoiceDraftCloudBridge';

export interface InvoiceDraftCloudState {
  /** Ob die Cloud-Seite freigegeben ist (Migration remote angewendet). */
  enabled: boolean;
  conflict: InvoiceDraftCloudConflict | null;
  /** Ein offener Konflikt sperrt Bearbeiten und Freigeben. */
  blocked: boolean;
  busy: boolean;
  /** Der einzige Änderungsweg des Editors — bei offenem Konflikt wirkungslos. */
  mutateDraft: InvoiceDraftDurabilitySession['mutateDraft'];
  takeCloud: () => Promise<InvoiceDraftCloudDecisionResult>;
  keepMine: () => Promise<InvoiceDraftCloudDecisionResult>;
  acceptEnd: () => Promise<InvoiceDraftCloudDecisionResult>;
  continueAsNew: () => Promise<InvoiceDraftCloudDecisionResult>;
  adoptOther: () => Promise<InvoiceDraftCloudDecisionResult>;
  keepOwnDiscardOther: () => Promise<InvoiceDraftCloudDecisionResult>;
  discard: () => Promise<InvoiceDraftCloudDecisionResult>;
}

const NOT_READY: InvoiceDraftCloudDecisionResult = { ok: false, reason: 'no_conflict' };

export function useInvoiceDraftCloudState(input: {
  session: InvoiceDraftDurabilitySession;
  /** Den Slot neu laden, nachdem eine Entscheidung den lokalen Datensatz ersetzt hat. */
  onReload: () => void;
}): InvoiceDraftCloudState {
  const { session, onReload } = input;
  const [conflict, setConflict] = useState<InvoiceDraftCloudConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const recordRef = useRef(session.record);
  recordRef.current = session.record;
  const draftIdRef = useRef<string | null>(session.record?.draftId ?? null);
  draftIdRef.current = session.record?.draftId ?? null;
  const draftRef = useRef<InvoiceDraft | null>(session.draft);
  draftRef.current = session.draft;
  const mutateRef = useRef(session.mutateDraft);
  mutateRef.current = session.mutateDraft;
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;
  const blockedRef = useRef(false);
  blockedRef.current = conflict !== null;
  const reconcilingRef = useRef(false);
  /*
   * Nach „Entwurf verwerfen" oder „Ende annehmen" ist der lokale Entwurf weg und
   * der Editor wird verlassen. Bis zum Unmount wird weder neu geladen (das legte
   * im leeren Slot sofort einen neuen Entwurf an) noch abgeglichen (der eigene
   * Grabstein erschiene sonst als „anderswo verworfen") noch bearbeitet.
   */
  const leftRef = useRef(false);

  /*
   * Abzug, Sendeergebnis, Sync-Lauf: Neu abgeglichen wird nur, wenn sich der
   * Cloud-Zustand **dieses** Entwurfs tatsächlich geändert hat. Der Abgleich
   * selbst schreibt nichts zurück (außer einem einmaligen Konfliktvermerk) —
   * so kann keine Speicherung eine weitere auslösen.
   */
  useEffect(() => {
    let seen = getInvoiceDraftCloudWatchKey(draftIdRef.current);
    const check = () => {
      let next: string;
      try {
        next = getInvoiceDraftCloudWatchKey(draftIdRef.current);
      } catch {
        return;
      }
      if (next === seen) return;
      seen = next;
      // Verschwindet der Entwurf aus dem Spiegel (Bereichswechsel, Abmelden), wird der Editor ohnehin verlassen.
      if (next === '') return;
      setTick((value) => value + 1);
    };
    const stopMutations = subscribeLocalMutations(check);
    const stopOutbox = subscribeSyncOutbox(check);
    const stopStatus = subscribeAutomaticSyncStatus(check);
    return () => {
      stopMutations();
      stopOutbox();
      stopStatus();
    };
  }, []);

  // Beim Verlassen des Editors den letzten bestätigten Stand sofort spiegeln.
  useEffect(() => () => {
    flushInvoiceDraftCloudMirror();
  }, []);

  const draftId = session.record?.draftId ?? null;
  const settled = session.status === 'ready' || session.status === 'saved';
  const active = session.record?.status === 'active';

  useEffect(() => {
    const record = recordRef.current;
    const draft = draftRef.current;
    if (!record || !draft || record.status !== 'active') {
      setConflict(null);
      return;
    }
    if (!settled || draft.id !== record.draftId || reconcilingRef.current || leftRef.current) return;
    reconcilingRef.current = true;
    try {
      const decision = reconcileInvoiceDraftOnOpen({ record, draft });
      if (decision.kind === 'adopt_remote') {
        // Fall D: lokal unverändert, Cloud neuer — über den regulären Speicherweg.
        setConflict(null);
        mutateRef.current(() => decision.draft);
      } else if (decision.kind === 'conflict') {
        setConflict(decision.conflict);
      } else {
        setConflict(getInvoiceDraftCloudConflict(record.draftId));
      }
    } catch {
      // Ein Abgleichsfehler darf den lokalen Editor nie sperren.
    } finally {
      reconcilingRef.current = false;
    }
  }, [draftId, settled, active, tick]);

  const mutateDraft = useCallback<InvoiceDraftDurabilitySession['mutateDraft']>((updater) => {
    if (blockedRef.current || leftRef.current) return;
    mutateRef.current(updater);
  }, []);

  const run = useCallback(
    async (
      action: (record: NonNullable<typeof session.record>, draft: InvoiceDraft) =>
        | InvoiceDraftCloudDecisionResult
        | Promise<InvoiceDraftCloudDecisionResult>,
      options: { leave?: boolean } = {},
    ): Promise<InvoiceDraftCloudDecisionResult> => {
      const record = recordRef.current;
      const draft = draftRef.current;
      if (!record || !draft || leftRef.current) return NOT_READY;
      // Ab jetzt kein Abgleich mehr: Der eigene Grabstein entsteht vor dem lokalen Löschen.
      if (options.leave) leftRef.current = true;
      setBusy(true);
      try {
        const result = await action(record, draft);
        if (!result.ok) {
          if (options.leave) leftRef.current = false;
          return result;
        }
        setConflict(null);
        if (options.leave) return result;
        if (result.reload) onReloadRef.current();
        setTick((value) => value + 1);
        return result;
      } catch {
        if (options.leave) leftRef.current = false;
        return { ok: false, reason: 'storage' };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return {
    enabled: isInvoiceDraftCloudSyncAllowed(),
    conflict,
    blocked: conflict !== null,
    busy,
    mutateDraft,
    takeCloud: () => run((record, draft) => takeCloudDraftVersion(record, draft)),
    keepMine: () => run((record, draft) => keepLocalDraftVersion(record, draft)),
    acceptEnd: () => run((record) => acceptCloudDraftEnd(record), { leave: true }),
    continueAsNew: () => run((record, draft) => continueDraftAsNew(record, draft)),
    adoptOther: () => run((record) => adoptSlotOwnerDraft(record)),
    keepOwnDiscardOther: () => run((record) => keepOwnDraftDiscardSlotOwner(record)),
    discard: () => run((record, draft) => discardInvoiceDraft(record, draft), { leave: true }),
  };
}
