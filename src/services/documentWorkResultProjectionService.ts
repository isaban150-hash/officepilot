/**
 * Pure WorkflowResult → DocumentWorkResult projection (no OCR/classify/extract).
 */
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type {
  DocumentWorkResult,
  DocumentWorkResultSpecialistRefs,
} from '../types/documentWorkResult';
import {
  DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
  DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
} from '../types/documentWorkResult';
import type { InboxItem, WorkflowResult } from '../types/models';
import { getInboxExtractedDocumentText } from './inboxDocumentText';

function cloneBusinessInterpretation(
  value: BusinessInterpretationResult | null,
): BusinessInterpretationResult | null {
  if (!value) return null;
  const cloned = JSON.parse(JSON.stringify(value)) as BusinessInterpretationResult;
  return { ...cloned, readOnly: true };
}

export function buildDocumentWorkResultSourceFingerprint(item: InboxItem): string {
  if (typeof item.sourceFileHash === 'string' && item.sourceFileHash.trim().length > 0) {
    return `hash:${item.sourceFileHash.trim()}`;
  }
  const text = getInboxExtractedDocumentText(item).trim();
  if (text.length === 0) {
    return `empty:${item.id}`;
  }
  // Stable non-crypto fingerprint for stale detection (not a security hash).
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `text:${(h >>> 0).toString(16)}:${text.length}`;
}

function buildSpecialistRefs(workflow: WorkflowResult): DocumentWorkResultSpecialistRefs {
  const derived = workflow.businessInterpretation?.derivedFrom;
  return {
    hasContractIntelligence: Boolean(
      workflow.contractIntelligence ?? derived?.hasContractIntelligence,
    ),
    hasContractOrderProposal: Boolean(
      workflow.contractOrderProposal ?? derived?.hasContractOrderProposal,
    ),
    hasClassification: Boolean(workflow.classification ?? derived?.hasClassification),
    hasDocumentUnderstanding: Boolean(
      workflow.documentUnderstanding ?? derived?.hasDocumentUnderstanding,
    ),
    companyRelevant: workflow.companyRelevant,
    classifiedKind: workflow.classifiedKind,
  };
}

export type ProjectDocumentWorkResultInput = {
  workflow: WorkflowResult;
  inboxItem: InboxItem;
  workspaceId?: string | null;
  analyzedAt?: string;
  analysisVersion?: string;
};

/**
 * Deterministic projection. Does not read stores or run specialists.
 * Overlay is always empty — callers merge with previous overlay.
 */
export function projectDocumentWorkResultFromWorkflow(
  input: ProjectDocumentWorkResultInput,
): DocumentWorkResult {
  const { workflow, inboxItem } = input;
  return {
    schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
    inboxItemId: inboxItem.id,
    workspaceId: input.workspaceId ?? null,
    analyzedAt: input.analyzedAt ?? new Date().toISOString(),
    analysisVersion: input.analysisVersion ?? DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    sourceFingerprint: buildDocumentWorkResultSourceFingerprint(inboxItem),
    businessInterpretation: cloneBusinessInterpretation(workflow.businessInterpretation),
    specialistRefs: buildSpecialistRefs(workflow),
    overlay: [],
  };
}
