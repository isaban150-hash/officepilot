/**
 * TestWorld gold validator — compares Expected vs OfficePilot runtime summary/match.
 * Does not change DocumentSummary / Matching / Workflow implementations.
 */
import { t, type TranslationKey } from '../i18n';
import {
  buildDocumentCaseMatch,
} from '../services/documentCaseMatchService';
import {
  buildInboxDocumentSummary,
  resolveDocumentSummaryFamily,
  createInboxWorkflowStub,
} from '../services/documentSummary';
import type { DocumentSummary } from '../types/documentSummary';
import type { InboxItem } from '../types/models';
import {
  type GoldDocumentBundle,
  type GoldMasterMaps,
  goldBundleToInboxItem,
  resolveTestWorldRoot,
} from './goldLoader';
import { extractGoldSourcePdfText } from './goldSourceText';

export type GoldValidationIssue = {
  documentId: string;
  area: 'classification' | 'summary' | 'caseMatch' | 'primaryAction' | 'alerts';
  message: string;
};

export type GoldValidationResult = {
  documentId: string;
  ok: boolean;
  issues: GoldValidationIssue[];
};

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function factOrderOk(factIds: string[], factOrder: string[]): boolean {
  const rank = new Map(factOrder.map((id, index) => [id, index]));
  let last = -1;
  for (const id of factIds) {
    // Extra runtime facts (e.g. amount on authority) are allowed; ordered ids must stay sorted.
    if (!rank.has(id)) continue;
    const idx = rank.get(id)!;
    if (idx < last) return false;
    last = idx;
  }
  return true;
}

function pushIssue(
  issues: GoldValidationIssue[],
  documentId: string,
  area: GoldValidationIssue['area'],
  message: string,
): void {
  issues.push({ documentId, area, message });
}

export function validateGoldDocument(
  bundle: GoldDocumentBundle,
  masters: GoldMasterMaps,
  itemOverride?: InboxItem,
): GoldValidationResult {
  const issues: GoldValidationIssue[] = [];
  const item = itemOverride ?? goldBundleToInboxItem(bundle, masters);
  return validateGoldDocumentWithItem(bundle, item, issues);
}

function validateGoldDocumentWithItem(
  bundle: GoldDocumentBundle,
  item: InboxItem,
  issues: GoldValidationIssue[],
): GoldValidationResult {
  const documentId = bundle.meta.id;
  const stub = createInboxWorkflowStub(item);
  const family = resolveDocumentSummaryFamily(item, stub, null);
  const summary: DocumentSummary = buildInboxDocumentSummary(item, { translate });
  const match = buildDocumentCaseMatch(item);

  // —— classification ——
  if (bundle.classification.documentId !== documentId) {
    pushIssue(issues, documentId, 'classification', 'documentId mismatch in classification.json');
  }
  if (bundle.classification.taxonomyTypeId !== bundle.meta.taxonomyTypeId) {
    pushIssue(
      issues,
      documentId,
      'classification',
      `taxonomyTypeId expected ${bundle.meta.taxonomyTypeId}, got ${bundle.classification.taxonomyTypeId}`,
    );
  }
  if (bundle.classification.documentType !== bundle.meta.documentType) {
    pushIssue(
      issues,
      documentId,
      'classification',
      `documentType expected ${bundle.meta.documentType}, got ${bundle.classification.documentType}`,
    );
  }
  if (bundle.classification.subtype !== bundle.meta.subtype) {
    pushIssue(
      issues,
      documentId,
      'classification',
      `subtype expected ${bundle.meta.subtype}, got ${bundle.classification.subtype}`,
    );
  }
  if (item.classifiedKind !== bundle.classification.classifiedKind) {
    pushIssue(
      issues,
      documentId,
      'classification',
      `classifiedKind fixture ${item.classifiedKind} ≠ expected ${bundle.classification.classifiedKind}`,
    );
  }
  if (family !== bundle.classification.family) {
    pushIssue(
      issues,
      documentId,
      'classification',
      `family runtime ${family} ≠ expected ${bundle.classification.family}`,
    );
  }
  if (summary.family !== bundle.summary.family) {
    pushIssue(
      issues,
      documentId,
      'summary',
      `summary.family runtime ${summary.family} ≠ expected ${bundle.summary.family}`,
    );
  }

  // —— summary facts ——
  const runtimeIds = summary.facts.map((f) => f.id);
  if (!factOrderOk(runtimeIds, bundle.summary.factOrder)) {
    pushIssue(
      issues,
      documentId,
      'summary',
      `fact order violated: runtime=[${runtimeIds.join(',')}] order=[${bundle.summary.factOrder.join(',')}]`,
    );
  }
  for (const expectedFact of bundle.summary.facts) {
    const runtime = summary.facts.find((f) => f.id === expectedFact.id);
    if (!runtime) {
      pushIssue(
        issues,
        documentId,
        'summary',
        `missing fact "${expectedFact.id}" (expected "${expectedFact.value}")`,
      );
      continue;
    }
    if (norm(runtime.value) !== norm(expectedFact.value)) {
      pushIssue(
        issues,
        documentId,
        'summary',
        `fact "${expectedFact.id}": runtime "${runtime.value}" ≠ expected "${expectedFact.value}"`,
      );
    }
  }

  // —— caseMatch ——
  if (match.matchStatus !== bundle.caseMatch.matchStatus) {
    pushIssue(
      issues,
      documentId,
      'caseMatch',
      `matchStatus runtime ${match.matchStatus} ≠ expected ${bundle.caseMatch.matchStatus}`,
    );
  }
  if (bundle.caseMatch.matchStatus === 'exact') {
    if (match.matchedCaseId !== bundle.caseMatch.matchedProjectId) {
      pushIssue(
        issues,
        documentId,
        'caseMatch',
        `matchedCaseId runtime ${match.matchedCaseId} ≠ expected project ${bundle.caseMatch.matchedProjectId}`,
      );
    }
  } else if (match.matchedCaseId != null) {
    pushIssue(
      issues,
      documentId,
      'caseMatch',
      `matchedCaseId should be null for status ${bundle.caseMatch.matchStatus}, got ${match.matchedCaseId}`,
    );
  }
  for (const reason of bundle.caseMatch.reasons) {
    if (!match.reasons.includes(reason as (typeof match.reasons)[number])) {
      pushIssue(
        issues,
        documentId,
        'caseMatch',
        `missing reason "${reason}" (runtime reasons: ${match.reasons.join(', ') || '—'})`,
      );
    }
  }

  // —— primaryAction (after case-match attach in inbox summary) ——
  if (summary.primaryAction.id !== bundle.primaryAction.id) {
    pushIssue(
      issues,
      documentId,
      'primaryAction',
      `primaryAction runtime ${summary.primaryAction.id} ≠ expected ${bundle.primaryAction.id}`,
    );
  }

  // —— alerts ——
  const runtimeAlertIds = summary.alerts.map((a) => a.id).sort();
  const expectedAlertIds = [...bundle.alerts.alertIds].sort();
  if (runtimeAlertIds.join('|') !== expectedAlertIds.join('|')) {
    pushIssue(
      issues,
      documentId,
      'alerts',
      `alertIds runtime [${runtimeAlertIds.join(', ')}] ≠ expected [${expectedAlertIds.join(', ')}]`,
    );
  }

  return { documentId, ok: issues.length === 0, issues };
}

export function formatGoldValidationReport(results: GoldValidationResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const lines: string[] = [
    `Gold validation: ${results.length} documents, ${failed.length} failed`,
  ];
  for (const result of failed) {
    lines.push(`\n${result.documentId}`);
    for (const issue of result.issues) {
      lines.push(`  [${issue.area}] ${issue.message}`);
    }
  }
  return lines.join('\n');
}

export async function validateAllGoldDocuments(
  bundles: GoldDocumentBundle[],
  masters: GoldMasterMaps,
  testWorldRoot: string = resolveTestWorldRoot(),
): Promise<GoldValidationResult[]> {
  const results: GoldValidationResult[] = [];
  for (const bundle of bundles) {
    const extractedText = await extractGoldSourcePdfText(bundle.meta.id, testWorldRoot);
    const item = goldBundleToInboxItem(bundle, masters, { extractedText });
    results.push(validateGoldDocument(bundle, masters, item));
  }
  return results;
}
