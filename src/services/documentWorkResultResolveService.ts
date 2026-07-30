/**
 * DOCUMENT-WORK-RESULT-01B — pure resolver: DWR overlay → DocumentWorkTruthView.
 * No store access. No WorkflowResult. No mutation of inputs.
 */
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type {
  DocumentWorkResult,
  DocumentWorkResultOverlayEntry,
} from '../types/documentWorkResult';
import type {
  DocumentWorkTruthResolvedSlot,
  DocumentWorkTruthSource,
  DocumentWorkTruthUnresolvedConflict,
  DocumentWorkTruthView,
} from '../types/documentWorkTruth';
import {
  cloneBusinessInterpretationForTruth,
  getDocumentWorkResultSlotHandler,
} from './documentWorkResultSlotRegistry';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type ResolveDocumentWorkResultInput = {
  documentWorkResult: DocumentWorkResult | null | undefined;
  liveBusinessInterpretation?: BusinessInterpretationResult | null;
  /**
   * Required when resolving live BI without a stored DWR
   * (empty overlay, source live_merged).
   */
  inboxItemId?: string;
  /**
   * DOCUMENT-ASSIST-02A — ephemeral Fill-Confirm / session overlay.
   * Wins over stored overlay for the same slotId. Not persisted.
   */
  sessionOverlayEntries?: DocumentWorkResultOverlayEntry[] | null;
  /** Confirmed Fill-Confirm fields without typed slots (pass-through onto TruthView). */
  sessionConfirmedExtraFacts?: Array<{ label: string; value: string }> | null;
};

/**
 * Merge stored + session overlay. Session entry replaces the same slotId.
 */
export function mergeDocumentWorkResultOverlayWithSession(
  stored: DocumentWorkResultOverlayEntry[],
  session: DocumentWorkResultOverlayEntry[] | null | undefined,
): DocumentWorkResultOverlayEntry[] {
  if (!session || session.length === 0) return cloneJson(stored);
  const bySlot = new Map<string, DocumentWorkResultOverlayEntry>();
  for (const entry of stored) {
    bySlot.set(entry.slotId, cloneJson(entry));
  }
  for (const entry of session) {
    bySlot.set(entry.slotId, cloneJson(entry));
  }
  return Array.from(bySlot.values());
}

function buildConflictLine(
  handlerConflictLabel: string,
  conflictReason?: string,
): string {
  const base = `Erneut prüfen: Der Dokumentinhalt hat sich seit Ihrer Bestätigung geändert. (Konflikt bei ${handlerConflictLabel})`;
  if (conflictReason === 'source_fingerprint_changed') return base;
  return base;
}

/**
 * German uncertainty lines for Overview / Assist (no technical slot IDs).
 */
export function buildDocumentWorkTruthConflictDisplayLines(
  truth: DocumentWorkTruthView,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const conflict of truth.unresolvedConflicts) {
    const handler = getDocumentWorkResultSlotHandler(conflict.slotId);
    const label = handler?.conflictLabel ?? 'Dokumentfeld';
    const line = buildConflictLine(label, conflict.conflictReason);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** Structured TruthView fact for Assist prompts and archive display (no marker parsing). */
export type DocumentWorkTruthAssistFact = {
  label: string;
  value: string;
  /** From TruthView slot provenance; discarded/conflict slots are omitted. */
  provenance: 'user_confirmed' | 'user_corrected' | 'analysis';
};

/**
 * Central structured fact list from an already-resolved TruthView.
 * Same slot inclusion / conflict skip / discarded skip as Assist context lines.
 */
export function listDocumentWorkTruthAssistFacts(
  truth: DocumentWorkTruthView,
): DocumentWorkTruthAssistFact[] {
  const bi = truth.businessInterpretation;
  const conflictSlotIds = new Set(truth.unresolvedConflicts.map((c) => c.slotId));

  const slotDisplayProvenance = (
    slotId: string,
  ): DocumentWorkTruthAssistFact['provenance'] | null => {
    const slot = truth.slots.find((entry) => entry.slotId === slotId);
    if (!slot) return 'analysis';
    if (slot.provenance === 'user_confirmed') return 'user_confirmed';
    if (slot.provenance === 'user_corrected') return 'user_corrected';
    if (slot.provenance === 'discarded' || slot.provenance === 'conflict') return null;
    return 'analysis';
  };

  const confirmedFirst: DocumentWorkTruthAssistFact[] = [];
  const otherFacts: DocumentWorkTruthAssistFact[] = [];

  const pushOrdered = (
    label: string,
    value: string | undefined,
    provenance: DocumentWorkTruthAssistFact['provenance'] | null,
  ) => {
    if (!value?.trim() || provenance == null) return;
    const fact: DocumentWorkTruthAssistFact = {
      label,
      value: value.trim(),
      provenance,
    };
    if (provenance === 'user_confirmed' || provenance === 'user_corrected') {
      confirmedFirst.push(fact);
    } else {
      otherFacts.push(fact);
    }
  };

  if (bi) {
    if (!conflictSlotIds.has('facts.parties.counterparty')) {
      pushOrdered(
        'Gegenpartei',
        bi.facts.parties.counterparty?.name,
        slotDisplayProvenance('facts.parties.counterparty'),
      );
    }
    if (!conflictSlotIds.has('facts.parties.ownCompany')) {
      pushOrdered(
        'Eigener Betrieb',
        bi.facts.parties.ownCompany?.name,
        slotDisplayProvenance('facts.parties.ownCompany'),
      );
    }
    if (!conflictSlotIds.has('facts.money.0')) {
      const money = bi.facts.money[0];
      const moneyLabel =
        money?.amountFormatted ??
        (money?.amount != null ? `${money.amount} ${money.currency ?? 'EUR'}` : money?.label);
      pushOrdered('Betrag', moneyLabel, slotDisplayProvenance('facts.money.0'));
    }
    if (!conflictSlotIds.has('facts.timeline.deadline')) {
      pushOrdered(
        'Frist',
        bi.facts.timeline.deadline?.value,
        slotDisplayProvenance('facts.timeline.deadline'),
      );
    }
    if (!conflictSlotIds.has('operational.nextStep')) {
      pushOrdered(
        'Nächster Schritt',
        bi.operational.nextStep,
        slotDisplayProvenance('operational.nextStep'),
      );
    }
    if (!conflictSlotIds.has('operational.confirmRequirement')) {
      pushOrdered(
        'Bestätigungserfordernis',
        bi.operational.confirmRequirement,
        slotDisplayProvenance('operational.confirmRequirement'),
      );
    }
    if (!conflictSlotIds.has('meaning.summary')) {
      pushOrdered(
        'Zusammenfassung',
        bi.meaning.summary,
        slotDisplayProvenance('meaning.summary'),
      );
    }
  }

  for (const extra of truth.sessionConfirmedExtraFacts ?? []) {
    if (!extra.value?.trim()) continue;
    confirmedFirst.push({
      label: extra.label,
      value: extra.value.trim(),
      provenance: 'user_confirmed',
    });
  }

  return [...confirmedFirst, ...otherFacts];
}

/**
 * Compact assist / free-question fact lines from a TruthView.
 * Prompt markers are formatting only — derived from structured provenance.
 */
export function buildDocumentWorkTruthAssistContextLines(
  truth: DocumentWorkTruthView,
): { factLines: string[]; conflictLines: string[] } {
  const factLines = listDocumentWorkTruthAssistFacts(truth).map((fact) => {
    if (fact.provenance === 'user_confirmed') {
      return `${fact.label}: ${fact.value} [Nutzerbestätigung]`;
    }
    if (fact.provenance === 'user_corrected') {
      return `${fact.label}: ${fact.value} [Nutzerkorrektur]`;
    }
    return `${fact.label}: ${fact.value}`;
  });

  const conflictLines = buildDocumentWorkTruthConflictDisplayLines(truth).map(
    (line) => `UNGELÖSTER KONFLIKT: ${line}`,
  );

  return { factLines, conflictLines };
}

function applyOverlayEntry(
  bi: BusinessInterpretationResult,
  entry: DocumentWorkResultOverlayEntry,
  slots: DocumentWorkTruthResolvedSlot[],
  unresolvedConflicts: DocumentWorkTruthUnresolvedConflict[],
  ignoredUnknownSlotIds: string[],
): BusinessInterpretationResult {
  const handler = getDocumentWorkResultSlotHandler(entry.slotId);
  if (!handler) {
    if (!ignoredUnknownSlotIds.includes(entry.slotId)) {
      ignoredUnknownSlotIds.push(entry.slotId);
    }
    return bi;
  }

  const analysisValue = cloneJson(handler.readAnalysisValue(bi));
  const userValue = entry.value === undefined ? null : cloneJson(entry.value);

  if (entry.reviewConflict) {
    const conflict: DocumentWorkTruthUnresolvedConflict = {
      slotId: handler.slotId,
      analysisValue,
      userValue,
      conflictReason: entry.conflictReason,
      status: entry.status,
    };
    if (!unresolvedConflicts.some((existing) => existing.slotId === conflict.slotId)) {
      unresolvedConflicts.push(conflict);
    }
    slots.push({
      slotId: handler.slotId,
      status: entry.status,
      provenance: 'conflict',
      analysisValue,
      userValue,
      effectiveValue: analysisValue,
      reviewConflict: true,
      conflictReason: entry.conflictReason,
    });
    // Keep analysis value as display base; do not silently apply user value.
    return bi;
  }

  if (entry.status === 'discarded') {
    const next = handler.discardValue(bi);
    slots.push({
      slotId: handler.slotId,
      status: entry.status,
      provenance: 'discarded',
      analysisValue,
      userValue,
      effectiveValue: null,
      reviewConflict: false,
      conflictReason: entry.conflictReason,
    });
    return { ...next, readOnly: true };
  }

  if (entry.status === 'user_confirmed' || entry.status === 'user_corrected') {
    if (!handler.isValidUserValue(entry.value)) {
      slots.push({
        slotId: handler.slotId,
        status: entry.status,
        provenance: 'analysis',
        analysisValue,
        userValue,
        effectiveValue: analysisValue,
        reviewConflict: false,
        conflictReason: entry.conflictReason,
        valueInvalid: true,
      });
      return bi;
    }
    const next = handler.applyUserValue(bi, entry.value);
    const effectiveValue = cloneJson(handler.readAnalysisValue(next));
    slots.push({
      slotId: handler.slotId,
      status: entry.status,
      provenance: entry.status,
      analysisValue,
      userValue,
      effectiveValue,
      reviewConflict: false,
      conflictReason: entry.conflictReason,
    });
    return { ...next, readOnly: true };
  }

  return bi;
}

/**
 * Pure resolver. Prefer live BI + stored overlay; else snapshot DWR.
 */
export function resolveDocumentWorkResult(
  input: ResolveDocumentWorkResultInput,
): DocumentWorkTruthView | null {
  const dwr = input.documentWorkResult ?? null;
  const liveBi = input.liveBusinessInterpretation;

  let source: DocumentWorkTruthSource;
  let baseBi: BusinessInterpretationResult | null;
  let inboxItemId: string;
  let analysisVersion: string;
  let sourceFingerprint: string;
  let overlay: DocumentWorkResultOverlayEntry[];

  if (liveBi) {
    source = 'live_merged';
    baseBi = cloneBusinessInterpretationForTruth(liveBi);
    inboxItemId = dwr?.inboxItemId ?? input.inboxItemId ?? liveBi.sourceDocument.sourceDocumentId;
    analysisVersion = dwr?.analysisVersion ?? 'live';
    sourceFingerprint = dwr?.sourceFingerprint ?? 'live';
    overlay = mergeDocumentWorkResultOverlayWithSession(
      dwr ? dwr.overlay : [],
      input.sessionOverlayEntries,
    );
  } else if (dwr?.businessInterpretation) {
    source = 'snapshot';
    baseBi = cloneBusinessInterpretationForTruth(dwr.businessInterpretation);
    inboxItemId = dwr.inboxItemId;
    analysisVersion = dwr.analysisVersion;
    sourceFingerprint = dwr.sourceFingerprint;
    overlay = mergeDocumentWorkResultOverlayWithSession(
      dwr.overlay,
      input.sessionOverlayEntries,
    );
  } else {
    return null;
  }

  if (!inboxItemId) return null;

  const slots: DocumentWorkTruthResolvedSlot[] = [];
  const unresolvedConflicts: DocumentWorkTruthUnresolvedConflict[] = [];
  const ignoredUnknownSlotIds: string[] = [];

  let effective = baseBi;
  for (const entry of overlay) {
    effective = applyOverlayEntry(
      effective,
      entry,
      slots,
      unresolvedConflicts,
      ignoredUnknownSlotIds,
    );
  }

  const sessionConfirmedExtraFacts = cloneJson(input.sessionConfirmedExtraFacts ?? []);

  return {
    inboxItemId,
    analysisVersion,
    sourceFingerprint,
    source,
    businessInterpretation: effective ? { ...effective, readOnly: true } : null,
    slots,
    unresolvedConflicts,
    ignoredUnknownSlotIds,
    sessionConfirmedExtraFacts,
  };
}
