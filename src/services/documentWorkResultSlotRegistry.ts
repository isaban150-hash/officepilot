/**
 * Typed overlay slot registry for DOCUMENT-WORK-RESULT-01B.
 * Explicit handlers only — no deep path mutation by free strings.
 */
import type {
  BusinessInterpretationResult,
  BusinessLabeledFact,
  BusinessStructuredMoney,
  BusinessStructuredParty,
} from '../types/businessInterpretation';
import type { DocumentWorkResultKnownSlotId } from '../types/documentWorkTruth';

export type DocumentWorkResultSlotHandler = {
  slotId: DocumentWorkResultKnownSlotId;
  /** Human-facing conflict label (German, no technical slot IDs). */
  conflictLabel: string;
  readAnalysisValue: (bi: BusinessInterpretationResult) => unknown;
  isValidUserValue: (value: unknown) => boolean;
  applyUserValue: (
    bi: BusinessInterpretationResult,
    value: unknown,
  ) => BusinessInterpretationResult;
  discardValue: (bi: BusinessInterpretationResult) => BusinessInterpretationResult;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMoneyValue(value: unknown): value is BusinessStructuredMoney {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BusinessStructuredMoney>;
  return typeof candidate.kind === 'string' && typeof candidate.certainty === 'string';
}

function isPartyValue(value: unknown): value is BusinessStructuredParty {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BusinessStructuredParty>;
  return isNonEmptyString(candidate.name) && typeof candidate.certainty === 'string';
}

function isLabeledFactValue(value: unknown): value is BusinessLabeledFact {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BusinessLabeledFact>;
  return isNonEmptyString(candidate.value) && typeof candidate.certainty === 'string';
}

function labeledFactFromString(value: string): BusinessLabeledFact {
  return {
    value: value.trim(),
    certainty: 'proposed',
    source: 'understanding',
  };
}

function normalizeLabeledFactInput(value: unknown): BusinessLabeledFact | null {
  if (isNonEmptyString(value)) return labeledFactFromString(value);
  if (isLabeledFactValue(value)) return cloneJson(value);
  return null;
}

function normalizePartyInput(value: unknown): BusinessStructuredParty | null {
  if (isNonEmptyString(value)) {
    return {
      name: value.trim(),
      relation: 'counterparty',
      certainty: 'proposed',
      source: 'understanding',
    };
  }
  if (isPartyValue(value)) return cloneJson(value);
  return null;
}

function normalizeMoneyInput(value: unknown): BusinessStructuredMoney | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      kind: 'other',
      amount: value,
      certainty: 'proposed',
      source: 'understanding',
    };
  }
  if (isMoneyValue(value)) return cloneJson(value);
  if (value && typeof value === 'object') {
    const candidate = value as { amount?: number; amountFormatted?: string; currency?: string };
    if (candidate.amount != null || isNonEmptyString(candidate.amountFormatted)) {
      return {
        kind: 'other',
        amount: typeof candidate.amount === 'number' ? candidate.amount : undefined,
        amountFormatted: candidate.amountFormatted,
        currency: candidate.currency,
        certainty: 'proposed',
        source: 'understanding',
      };
    }
  }
  return null;
}

const nextStepHandler: DocumentWorkResultSlotHandler = {
  slotId: 'operational.nextStep',
  conflictLabel: 'nächsten Schritt',
  readAnalysisValue: (bi) => bi.operational.nextStep,
  isValidUserValue: (value) => isNonEmptyString(value),
  applyUserValue: (bi, value) => ({
    ...bi,
    operational: { ...bi.operational, nextStep: String(value).trim() },
  }),
  discardValue: (bi) => ({
    ...bi,
    operational: { ...bi.operational, nextStep: '' },
  }),
};

const confirmRequirementHandler: DocumentWorkResultSlotHandler = {
  slotId: 'operational.confirmRequirement',
  conflictLabel: 'Bestätigungserfordernis',
  readAnalysisValue: (bi) => bi.operational.confirmRequirement,
  isValidUserValue: (value) => isNonEmptyString(value),
  applyUserValue: (bi, value) => ({
    ...bi,
    operational: { ...bi.operational, confirmRequirement: String(value).trim() },
  }),
  discardValue: (bi) => ({
    ...bi,
    operational: { ...bi.operational, confirmRequirement: '' },
  }),
};

const money0Handler: DocumentWorkResultSlotHandler = {
  slotId: 'facts.money.0',
  conflictLabel: 'Betrag',
  readAnalysisValue: (bi) => bi.facts.money[0] ?? null,
  isValidUserValue: (value) => normalizeMoneyInput(value) != null,
  applyUserValue: (bi, value) => {
    const money = normalizeMoneyInput(value);
    if (!money) return bi;
    const next = [...bi.facts.money];
    if (next.length === 0) next.push(money);
    else next[0] = money;
    return { ...bi, facts: { ...bi.facts, money: next } };
  },
  discardValue: (bi) => {
    if (bi.facts.money.length === 0) return bi;
    return { ...bi, facts: { ...bi.facts, money: bi.facts.money.slice(1) } };
  },
};

const counterpartyHandler: DocumentWorkResultSlotHandler = {
  slotId: 'facts.parties.counterparty',
  conflictLabel: 'Gegenpartei',
  readAnalysisValue: (bi) => bi.facts.parties.counterparty ?? null,
  isValidUserValue: (value) => normalizePartyInput(value) != null,
  applyUserValue: (bi, value) => {
    const party = normalizePartyInput(value);
    if (!party) return bi;
    return {
      ...bi,
      facts: {
        ...bi.facts,
        parties: { ...bi.facts.parties, counterparty: party },
      },
    };
  },
  discardValue: (bi) => ({
    ...bi,
    facts: {
      ...bi.facts,
      parties: { ...bi.facts.parties, counterparty: undefined },
    },
  }),
};

const ownCompanyHandler: DocumentWorkResultSlotHandler = {
  slotId: 'facts.parties.ownCompany',
  conflictLabel: 'eigener Betrieb',
  readAnalysisValue: (bi) => bi.facts.parties.ownCompany ?? null,
  isValidUserValue: (value) => normalizePartyInput(value) != null,
  applyUserValue: (bi, value) => {
    const party = normalizePartyInput(value);
    if (!party) return bi;
    return {
      ...bi,
      facts: {
        ...bi.facts,
        parties: {
          ...bi.facts.parties,
          ownCompany: { ...party, relation: 'own_company' },
        },
      },
    };
  },
  discardValue: (bi) => ({
    ...bi,
    facts: {
      ...bi.facts,
      parties: { ...bi.facts.parties, ownCompany: undefined },
    },
  }),
};

const deadlineHandler: DocumentWorkResultSlotHandler = {
  slotId: 'facts.timeline.deadline',
  conflictLabel: 'Frist',
  readAnalysisValue: (bi) => bi.facts.timeline.deadline ?? null,
  isValidUserValue: (value) => normalizeLabeledFactInput(value) != null,
  applyUserValue: (bi, value) => {
    const fact = normalizeLabeledFactInput(value);
    if (!fact) return bi;
    return {
      ...bi,
      facts: {
        ...bi.facts,
        timeline: { ...bi.facts.timeline, deadline: fact },
      },
    };
  },
  discardValue: (bi) => ({
    ...bi,
    facts: {
      ...bi.facts,
      timeline: { ...bi.facts.timeline, deadline: undefined },
    },
  }),
};

const meaningSummaryHandler: DocumentWorkResultSlotHandler = {
  slotId: 'meaning.summary',
  conflictLabel: 'Zusammenfassung',
  readAnalysisValue: (bi) => bi.meaning.summary,
  isValidUserValue: (value) => isNonEmptyString(value),
  applyUserValue: (bi, value) => ({
    ...bi,
    meaning: { ...bi.meaning, summary: String(value).trim() },
  }),
  discardValue: (bi) => ({
    ...bi,
    meaning: { ...bi.meaning, summary: '' },
  }),
};

export const DOCUMENT_WORK_RESULT_SLOT_HANDLERS: readonly DocumentWorkResultSlotHandler[] = [
  nextStepHandler,
  confirmRequirementHandler,
  money0Handler,
  counterpartyHandler,
  ownCompanyHandler,
  deadlineHandler,
  meaningSummaryHandler,
];

const HANDLER_BY_ID = new Map(
  DOCUMENT_WORK_RESULT_SLOT_HANDLERS.map((handler) => [handler.slotId, handler]),
);

export function getDocumentWorkResultSlotHandler(
  slotId: string,
): DocumentWorkResultSlotHandler | null {
  return HANDLER_BY_ID.get(slotId as DocumentWorkResultKnownSlotId) ?? null;
}

export function isDocumentWorkResultKnownSlotId(
  slotId: string,
): slotId is DocumentWorkResultKnownSlotId {
  return HANDLER_BY_ID.has(slotId as DocumentWorkResultKnownSlotId);
}

export function cloneBusinessInterpretationForTruth(
  value: BusinessInterpretationResult,
): BusinessInterpretationResult {
  const cloned = cloneJson(value);
  return { ...cloned, readOnly: true };
}
