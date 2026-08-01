/**
 * TESTWORLD-IMPLEMENTATION-03B — gold regression against OfficePilot presentation logic.
 * Loads all gold metas + expected; fails with per-document reports (e.g. DOC-00017).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetTestStores } from '../test/resetStores';
import {
  goldProjectsToVorgaenge,
  loadAllGoldDocuments,
  loadGoldMasterData,
  resolveTestWorldRoot,
} from './goldLoader';
import {
  formatGoldValidationReport,
  validateAllGoldDocuments,
} from './goldValidator';

describe('TESTWORLD gold regression 03B', () => {
  const testWorldRoot = resolveTestWorldRoot();
  const masters = loadGoldMasterData(testWorldRoot);
  const bundles = loadAllGoldDocuments(testWorldRoot);

  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore(goldProjectsToVorgaenge(masters));
  });

  it('loads all 35 gold documents with expected bundles', () => {
    expect(bundles.length).toBe(35);
    expect(bundles.map((b) => b.meta.id)).toEqual(
      Array.from({ length: 35 }, (_, i) => `DOC-${String(i + 1).padStart(5, '0')}`),
    );
    for (const bundle of bundles) {
      expect(bundle.classification.documentId).toBe(bundle.meta.id);
      expect(bundle.summary.documentId).toBe(bundle.meta.id);
      expect(bundle.caseMatch.documentId).toBe(bundle.meta.id);
      expect(bundle.primaryAction.documentId).toBe(bundle.meta.id);
      expect(bundle.alerts.documentId).toBe(bundle.meta.id);
    }
  });

  it('validates classification, summary, caseMatch, primaryAction, alerts for every gold document', () => {
    const results = validateAllGoldDocuments(bundles, masters);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      expect.fail(formatGoldValidationReport(results));
    }
    expect(results).toHaveLength(35);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
