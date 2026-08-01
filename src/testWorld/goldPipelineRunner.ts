/**
 * TESTWORLD-04B — run gold source.pdf through real OfficePilot intake pipeline.
 * Measurement only: no OCR / Workflow / Summary / Matching / UI changes.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { t, type TranslationKey } from '../i18n';
import {
  confirmPendingDocumentIntake,
  processDocumentFileForPreview,
} from '../services/pendingDocumentIntakeService';
import { processUploadedDocument } from '../services/intakeWorkflowService';
import {
  buildInboxDocumentSummary,
  resolveDocumentSummaryFamily,
  createInboxWorkflowStub,
} from '../services/documentSummary';
import { buildDocumentCaseMatch } from '../services/documentCaseMatchService';
import type { InboxItem } from '../types/models';
import type { DocumentSummary } from '../types/documentSummary';
import {
  type GoldDocumentBundle,
  type GoldMasterMaps,
  loadAllGoldDocuments,
  loadGoldMasterData,
  resolveTestWorldRoot,
} from './goldLoader';

export type PipelineAreaStatus = {
  ok: boolean;
  expected: string;
  actual: string;
  details?: string[];
};

export type GoldPipelineDocReport = {
  documentId: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  extractionMethod?: string;
  ocrAttempted?: boolean;
  classifiedKind: { expected: string; actual: string; ok: boolean };
  family: { expected: string; actual: string; ok: boolean };
  summary: PipelineAreaStatus;
  caseMatch: PipelineAreaStatus;
  primaryAction: PipelineAreaStatus;
  alerts: PipelineAreaStatus;
  error?: string;
};

export type GoldPipelineSuiteReport = {
  generatedAt: string;
  checked: number;
  pass: number;
  fail: number;
  error: number;
  successRate: string;
  documents: GoldPipelineDocReport[];
  deviations: string[];
};

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** ISO `YYYY-MM-DD` ↔ German `DD.MM.YYYY` / `DD/MM/YYYY` for summary date facts. */
function toComparableDate(value: string): string | null {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const de = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (!de) return null;
  const year = de[3].length === 2 ? `20${de[3]}` : de[3];
  return `${year}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;
}

function summaryFactValuesEqual(id: string, actual: string, expected: string): boolean {
  if (norm(actual) === norm(expected)) return true;
  if (id === 'date' || id === 'deadline') {
    const a = toComparableDate(actual);
    const b = toComparableDate(expected);
    return Boolean(a && b && a === b);
  }
  return false;
}

function factOrderOk(factIds: string[], factOrder: string[]): boolean {
  const rank = new Map(factOrder.map((id, index) => [id, index]));
  let last = -1;
  for (const id of factIds) {
    if (!rank.has(id)) continue;
    const idx = rank.get(id)!;
    if (idx < last) return false;
    last = idx;
  }
  return true;
}

export function loadGoldPdfBytes(
  documentId: string,
  testWorldRoot: string = resolveTestWorldRoot(),
): Uint8Array {
  const pdfPath = join(testWorldRoot, 'documents', documentId, 'source.pdf');
  if (!existsSync(pdfPath)) {
    throw new Error(`Missing ${pdfPath} — run: node test-world/_lib/seed-04a-sources.mjs`);
  }
  // Copy into a plain Uint8Array — Node Buffer as BlobPart is unreliable in happy-dom.
  return new Uint8Array(readFileSync(pdfPath));
}

function loadPdfFile(documentId: string, testWorldRoot: string): File {
  const bytes = loadGoldPdfBytes(documentId, testWorldRoot);
  return new File([bytes], `${documentId}-source.pdf`, { type: 'application/pdf' });
}

export async function runGoldPdfThroughPipeline(
  documentId: string,
  testWorldRoot: string = resolveTestWorldRoot(),
): Promise<{
  item: InboxItem;
  summary: DocumentSummary;
  extractionMethod?: string;
  ocrAttempted?: boolean;
}> {
  const file = loadPdfFile(documentId, testWorldRoot);
  const preview = await processDocumentFileForPreview(file);
  if (!preview.success) {
    throw new Error(`preview failed: ${preview.error}`);
  }

  const intake = await confirmPendingDocumentIntake(preview.pending, {
    userDecision: 'save_permanently',
    importSource: 'upload',
  });
  if (!intake.success) {
    throw new Error(`intake failed: ${intake.error}`);
  }
  if (intake.duplicate) {
    throw new Error('intake returned duplicate unexpectedly');
  }

  processUploadedDocument(intake.inboxItem.id);
  const item = intake.inboxItem;
  const summary = buildInboxDocumentSummary(item, { translate });
  return {
    item,
    summary,
    extractionMethod: preview.pending.extraction.extractionMethod,
    ocrAttempted: preview.pending.extraction.ocrAttempted,
  };
}

export function comparePipelineToExpected(
  bundle: GoldDocumentBundle,
  item: InboxItem,
  summary: DocumentSummary,
  meta?: { extractionMethod?: string; ocrAttempted?: boolean },
): GoldPipelineDocReport {
  const documentId = bundle.meta.id;
  const stub = createInboxWorkflowStub(item);
  const family = resolveDocumentSummaryFamily(item, stub, null);
  const match = summary.caseMatch ?? buildDocumentCaseMatch(item);

  const summaryDetails: string[] = [];
  if (summary.family !== bundle.summary.family) {
    summaryDetails.push(`family ${summary.family} ≠ ${bundle.summary.family}`);
  }
  const runtimeIds = summary.facts.map((f) => f.id);
  if (!factOrderOk(runtimeIds, bundle.summary.factOrder)) {
    summaryDetails.push(`factOrder runtime=[${runtimeIds.join(',')}]`);
  }
  for (const expectedFact of bundle.summary.facts) {
    const runtime = summary.facts.find((f) => f.id === expectedFact.id);
    if (!runtime) {
      summaryDetails.push(`missing fact ${expectedFact.id}`);
      continue;
    }
    if (!summaryFactValuesEqual(expectedFact.id, runtime.value, expectedFact.value)) {
      summaryDetails.push(
        `fact ${expectedFact.id}: "${runtime.value}" ≠ "${expectedFact.value}"`,
      );
    }
  }

  const caseDetails: string[] = [];
  if (match.matchStatus !== bundle.caseMatch.matchStatus) {
    caseDetails.push(
      `status ${match.matchStatus} ≠ ${bundle.caseMatch.matchStatus}`,
    );
  }
  if (bundle.caseMatch.matchStatus === 'exact') {
    if (match.matchedCaseId !== bundle.caseMatch.matchedProjectId) {
      caseDetails.push(
        `matched ${match.matchedCaseId ?? 'null'} ≠ ${bundle.caseMatch.matchedProjectId}`,
      );
    }
  } else if (match.matchedCaseId != null) {
    caseDetails.push(`matchedCaseId unexpected ${match.matchedCaseId}`);
  }

  const alertActual = summary.alerts.map((a) => a.id).sort().join(', ') || '—';
  const alertExpected = [...bundle.alerts.alertIds].sort().join(', ') || '—';

  const classifiedOk = item.classifiedKind === bundle.classification.classifiedKind;
  const familyOk = family === bundle.classification.family;
  const summaryOk = summaryDetails.length === 0;
  const caseMatchOk = caseDetails.length === 0;
  const primaryOk = summary.primaryAction.id === bundle.primaryAction.id;
  const alertsOk = alertActual === alertExpected;
  const status: GoldPipelineDocReport['status'] =
    classifiedOk && familyOk && summaryOk && caseMatchOk && primaryOk && alertsOk
      ? 'PASS'
      : 'FAIL';

  return {
    documentId,
    status,
    extractionMethod: meta?.extractionMethod,
    ocrAttempted: meta?.ocrAttempted,
    classifiedKind: {
      expected: bundle.classification.classifiedKind,
      actual: item.classifiedKind ?? 'undefined',
      ok: classifiedOk,
    },
    family: {
      expected: bundle.classification.family,
      actual: family,
      ok: familyOk,
    },
    summary: {
      ok: summaryOk,
      expected: `family=${bundle.summary.family}; facts=${bundle.summary.facts.map((f) => f.id).join(',')}`,
      actual: `family=${summary.family}; facts=${runtimeIds.join(',')}`,
      details: summaryDetails,
    },
    caseMatch: {
      ok: caseMatchOk,
      expected: `${bundle.caseMatch.matchStatus}/${bundle.caseMatch.matchedProjectId ?? 'null'}`,
      actual: `${match.matchStatus}/${match.matchedCaseId ?? 'null'}`,
      details: caseDetails,
    },
    primaryAction: {
      ok: primaryOk,
      expected: bundle.primaryAction.id,
      actual: summary.primaryAction.id,
    },
    alerts: {
      ok: alertsOk,
      expected: alertExpected,
      actual: alertActual,
    },
  };
}

export function formatPipelineDocReport(doc: GoldPipelineDocReport): string {
  const lines = [
    `${doc.documentId} — ${doc.status}`,
    `  extraction: ${doc.extractionMethod ?? '—'} (ocrAttempted=${doc.ocrAttempted ?? '—'})`,
    `  Dokumenttyp erkannt: ${doc.classifiedKind.actual}`,
    `  Erwartet:             ${doc.classifiedKind.expected}`,
    `  Family:               ${doc.family.actual} (erwartet ${doc.family.expected}) ${doc.family.ok ? 'OK' : 'FEHLER'}`,
    `  Summary:              ${doc.summary.ok ? 'OK' : 'FEHLER'}`,
    `    erwartet: ${doc.summary.expected}`,
    `    tatsächlich: ${doc.summary.actual}`,
    ...(doc.summary.details ?? []).map((d) => `    - ${d}`),
    `  CaseMatch:            ${doc.caseMatch.ok ? 'OK' : 'FEHLER'}`,
    `    erwartet: ${doc.caseMatch.expected}`,
    `    tatsächlich: ${doc.caseMatch.actual}`,
    ...(doc.caseMatch.details ?? []).map((d) => `    - ${d}`),
    `  Primäraktion:         ${doc.primaryAction.ok ? 'OK' : 'FEHLER'} (${doc.primaryAction.actual} / erwartet ${doc.primaryAction.expected})`,
    `  Alerts:               ${doc.alerts.ok ? 'OK' : 'FEHLER'} (${doc.alerts.actual} / erwartet ${doc.alerts.expected})`,
    `  Gesamtstatus:         ${doc.status}`,
  ];
  if (doc.error) lines.push(`  ERROR: ${doc.error}`);
  return lines.join('\n');
}

export function buildSuiteReport(documents: GoldPipelineDocReport[]): GoldPipelineSuiteReport {
  const pass = documents.filter((d) => d.status === 'PASS').length;
  const fail = documents.filter((d) => d.status === 'FAIL').length;
  const error = documents.filter((d) => d.status === 'ERROR').length;
  const checked = documents.length;
  const successRate =
    checked === 0 ? '0%' : `${((pass / checked) * 100).toFixed(1)}%`;
  const deviations: string[] = [];
  for (const doc of documents) {
    if (doc.status === 'PASS') continue;
    if (doc.error) {
      deviations.push(`${doc.documentId}: ERROR ${doc.error}`);
      continue;
    }
    if (!doc.classifiedKind.ok) {
      deviations.push(
        `${doc.documentId}: classifiedKind ${doc.classifiedKind.actual} ≠ ${doc.classifiedKind.expected}`,
      );
    }
    if (!doc.family.ok) {
      deviations.push(
        `${doc.documentId}: family ${doc.family.actual} ≠ ${doc.family.expected}`,
      );
    }
    if (!doc.summary.ok) {
      for (const d of doc.summary.details ?? ['summary mismatch']) {
        deviations.push(`${doc.documentId}: summary — ${d}`);
      }
    }
    if (!doc.caseMatch.ok) {
      for (const d of doc.caseMatch.details ?? ['caseMatch mismatch']) {
        deviations.push(`${doc.documentId}: caseMatch — ${d}`);
      }
    }
    if (!doc.primaryAction.ok) {
      deviations.push(
        `${doc.documentId}: primaryAction ${doc.primaryAction.actual} ≠ ${doc.primaryAction.expected}`,
      );
    }
    if (!doc.alerts.ok) {
      deviations.push(
        `${doc.documentId}: alerts [${doc.alerts.actual}] ≠ [${doc.alerts.expected}]`,
      );
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    checked,
    pass,
    fail,
    error,
    successRate,
    documents,
    deviations,
  };
}

export function formatSuiteReport(report: GoldPipelineSuiteReport): string {
  const lines = [
    'TESTWORLD Gold PDF Pipeline 04B',
    `generatedAt: ${report.generatedAt}`,
    `checked: ${report.checked}`,
    `PASS: ${report.pass}`,
    `FAIL: ${report.fail}`,
    `ERROR: ${report.error}`,
    `Erfolgsquote: ${report.successRate}`,
    '',
    '--- Dokumente ---',
  ];
  for (const doc of report.documents) {
    lines.push('');
    lines.push(formatPipelineDocReport(doc));
  }
  lines.push('');
  lines.push('--- Abweichungen ---');
  if (report.deviations.length === 0) {
    lines.push('(keine)');
  } else {
    for (const d of report.deviations) lines.push(`- ${d}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeSuiteReport(
  report: GoldPipelineSuiteReport,
  testWorldRoot: string = resolveTestWorldRoot(),
): string {
  const dir = join(testWorldRoot, 'reports');
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, 'gold-pipeline-04b.md');
  const jsonPath = join(dir, 'gold-pipeline-04b.json');
  writeFileSync(mdPath, formatSuiteReport(report), 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return mdPath;
}

export async function runAllGoldPdfPipeline(
  masters: GoldMasterMaps = loadGoldMasterData(),
  bundles: GoldDocumentBundle[] = loadAllGoldDocuments(),
  testWorldRoot: string = resolveTestWorldRoot(),
  options?: {
    /** Called before each document (e.g. reset stores + hydrate vorgänge). */
    beforeEachDoc?: () => void | Promise<void>;
  },
): Promise<GoldPipelineSuiteReport> {
  void masters;
  const documents: GoldPipelineDocReport[] = [];

  for (const bundle of bundles) {
    if (options?.beforeEachDoc) {
      await options.beforeEachDoc();
    }
    try {
      const result = await runGoldPdfThroughPipeline(bundle.meta.id, testWorldRoot);
      documents.push(
        comparePipelineToExpected(bundle, result.item, result.summary, {
          extractionMethod: result.extractionMethod,
          ocrAttempted: result.ocrAttempted,
        }),
      );
    } catch (err) {
      documents.push({
        documentId: bundle.meta.id,
        status: 'ERROR',
        classifiedKind: {
          expected: bundle.classification.classifiedKind,
          actual: '—',
          ok: false,
        },
        family: {
          expected: bundle.classification.family,
          actual: '—',
          ok: false,
        },
        summary: { ok: false, expected: '—', actual: '—' },
        caseMatch: { ok: false, expected: '—', actual: '—' },
        primaryAction: { ok: false, expected: '—', actual: '—' },
        alerts: { ok: false, expected: '—', actual: '—' },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return buildSuiteReport(documents);
}
