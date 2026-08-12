/**
 * TESTWORLD-IMPLEMENTATION-04B — measure real PDF pipeline vs gold expected.
 * Does not change OCR / Workflow / DocumentSummary / Matching / UI / Expected / PDFs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { resetTestStores } from '../test/resetStores';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetDocumentFileStoreForTests } from '../services/documentFileStoreService';
import {
  goldProjectsToVorgaenge,
  listGoldDocumentIds,
  loadAllGoldDocuments,
  loadGoldMasterData,
  resolveTestWorldRoot,
} from './goldLoader';
import {
  formatSuiteReport,
  loadGoldPdfBytes,
  runAllGoldPdfPipeline,
  writeSuiteReport,
} from './goldPipelineRunner';
import { installGoldPdfJsVitestBridge } from './goldPdfJsVitestBridge';
import { loadPdfDocument } from '../services/pdfDocumentService';
import { processDocumentFileForPreview } from '../services/pendingDocumentIntakeService';
import { existsSync } from 'fs';
import { join } from 'path';

useDocumentBlobDatabaseReset();

describe('TESTWORLD gold PDF pipeline 04B', () => {
  const testWorldRoot = resolveTestWorldRoot();
  const masters = loadGoldMasterData(testWorldRoot);
  const bundles = loadAllGoldDocuments(testWorldRoot);
  let uninstallPdfBridge: (() => void) | undefined;

  beforeAll(async () => {
    uninstallPdfBridge = await installGoldPdfJsVitestBridge();
  });

  afterAll(() => {
    uninstallPdfBridge?.();
  });

  beforeEach(() => {
    resetTestStores();
    resetDocumentFileStoreForTests();
    hydrateVorgangStore(goldProjectsToVorgaenge(masters));
  });

  it('has 35 gold source.pdf files', () => {
    const ids = listGoldDocumentIds(testWorldRoot);
    expect(ids).toHaveLength(35);
    for (const id of ids) {
      expect(existsSync(join(testWorldRoot, 'documents', id, 'source.pdf')), id).toBe(true);
    }
  });

  it('Vitest pdf.js bridge loads DOC-00001 and preview extracts text', async () => {
    const bytes = loadGoldPdfBytes('DOC-00001', testWorldRoot);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const loaded = await loadPdfDocument(bytes);
    expect(loaded.pageCount).toBeGreaterThanOrEqual(1);
    await loaded.pdf.destroy();

    const file = new File([bytes], 'DOC-00001-source.pdf', { type: 'application/pdf' });
    expect(file.size).toBe(bytes.byteLength);
    const ab = await file.arrayBuffer();
    expect(ab.byteLength).toBe(bytes.byteLength);

    const preview = await processDocumentFileForPreview(file);
    expect(preview.success, preview.success ? '' : preview.error).toBe(true);
    if (preview.success) {
      expect(preview.pending.extraction.recognizedText.length).toBeGreaterThan(20);
    }
  });

  it(
    'runs all 35 source.pdf through real OfficePilot pipeline and reports vs expected',
    async () => {
      const report = await runAllGoldPdfPipeline(masters, bundles, testWorldRoot, {
        beforeEachDoc: () => {
          resetTestStores();
          resetDocumentFileStoreForTests();
          hydrateVorgangStore(goldProjectsToVorgaenge(masters));
        },
      });

      const reportPath = writeSuiteReport(report, testWorldRoot);
      // eslint-disable-next-line no-console
      console.log(formatSuiteReport(report));
      // eslint-disable-next-line no-console
      console.log(`Report written: ${reportPath}`);

      // Regression gate on the live comparison: all 35 PDFs must run through the
      // pipeline (no ERROR) and none may deviate from Expected (no FAIL). The written
      // report stays a diagnostic artifact — it is never the source of truth.
      expect(report.checked).toBe(35);
      expect(report.error).toBe(0);
      expect(report.fail, report.deviations.join('\n')).toBe(0);
      expect(existsSync(reportPath)).toBe(true);
    },
    300_000,
  );
});
