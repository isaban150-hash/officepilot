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
};

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

/**
 * Compact assist / free-question fact lines from a TruthView.
 */
export function buildDocumentWorkTruthAssistContextLines(
  truth: DocumentWorkTruthView,
): { factLines: string[]; conflictLines: string[] } {
  const bi = truth.businessInterpretation;
  const factLines: string[] = [];
  const conflictSlotIds = new Set(truth.unresolvedConflicts.map((c) => c.slotId));

  const pushFact = (label: string, value: string | undefined, provenance?: string) => {
    if (!value?.trim()) return;
    const suffix = provenance ? ` [${provenance}]` : '';
    factLines.push(`${label}: ${value.trim()}${suffix}`);
  };

  const slotProvenance = (slotId: string): string | undefined => {
    const slot = truth.slots.find((entry) => entry.slotId === slotId);
    if (!slot) return undefined;
    if (slot.provenance === 'user_confirmed') return 'Nutzerbestätigung';
    if (slot.provenance === 'user_corrected') return 'Nutzerkorrektur';
    if (slot.provenance === 'discarded') return undefined;
    if (slot.provenance === 'conflict') return undefined;
    return undefined;
  };

  if (bi) {
    if (!conflictSlotIds.has('facts.parties.counterparty')) {
      pushFact(
        'Gegenpartei',
        bi.facts.parties.counterparty?.name,
        slotProvenance('facts.parties.counterparty'),
      );
    }
    if (!conflictSlotIds.has('facts.parties.ownCompany')) {
      pushFact(
        'Eigener Betrieb',
        bi.facts.parties.ownCompany?.name,
        slotProvenance('facts.parties.ownCompany'),
      );
    }
    if (!conflictSlotIds.has('facts.money.0')) {
      const money = bi.facts.money[0];
      const moneyLabel =
        money?.amountFormatted ??
        (money?.amount != null ? `${money.amount} ${money.currency ?? 'EUR'}` : money?.label);
      pushFact('Betrag', moneyLabel, slotProvenance('facts.money.0'));
    }
    if (!conflictSlotIds.has('facts.timeline.deadline')) {
      pushFact(
        'Frist',
        bi.facts.timeline.deadline?.value,
        slotProvenance('facts.timeline.deadline'),
      );
    }
    if (!conflictSlotIds.has('operational.nextStep')) {
      pushFact('Nächster Schritt', bi.operational.nextStep, slotProvenance('operational.nextStep'));
    }
    if (!conflictSlotIds.has('operational.confirmRequirement')) {
      pushFact(
        'Bestätigungserfordernis',
        bi.operational.confirmRequirement,
        slotProvenance('operational.confirmRequirement'),
      );
    }
    if (!conflictSlotIds.has('meaning.summary')) {
      pushFact('Zusammenfassung', bi.meaning.summary, slotProvenance('meaning.summary'));
    }
  }

  // Discarded slots must not appear as valid facts (already skipped via empty BI fields).
  for (const slot of truth.slots) {
    if (slot.provenance === 'discarded') {
      // Explicit exclusion note only when needed for assist clarity — omit positive fact.
      continue;
    }
  }

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
    overlay = dwr ? cloneJson(dwr.overlay) : [];
  } else if (dwr?.businessInterpretation) {
    source = 'snapshot';
    baseBi = cloneBusinessInterpretationForTruth(dwr.businessInterpretation);
    inboxItemId = dwr.inboxItemId;
    analysisVersion = dwr.analysisVersion;
    sourceFingerprint = dwr.sourceFingerprint;
    overlay = cloneJson(dwr.overlay);
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

  return {
    inboxItemId,
    analysisVersion,
    sourceFingerprint,
    source,
    businessInterpretation: effective ? { ...effective, readOnly: true } : null,
    slots,
    unresolvedConflicts,
    ignoredUnknownSlotIds,
  };
}
