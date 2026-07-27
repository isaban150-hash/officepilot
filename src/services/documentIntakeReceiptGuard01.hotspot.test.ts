/**
 * DOCUMENT-INTAKE-RECEIPT-GUARD-01 — hotspot regression after hang fix.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import {
  buildCanonicalDocumentText,
  zoneDocumentText,
} from './documentZoningService';
import { extractDocumentFeatures } from './documentFeatureExtractionService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { shouldSkipReceiptAnalysisForContractDocument } from './documentReceiptAnalysisGate';

describe('DOCUMENT-INTAKE-RECEIPT-GUARD-01 hotspot regression', () => {
  it('receipt pipeline stages complete quickly on WV when forced (page-span hang fixed)', () => {
    const pages = buildSyntheticWerkvertragPages();
    const text = buildCanonicalDocumentText(buildSyntheticWerkvertragText(), pages);

    const zoneT0 = performance.now();
    const zoned = zoneDocumentText(text, pages);
    const zoneMs = performance.now() - zoneT0;

    const featureT0 = performance.now();
    extractDocumentFeatures(zoned);
    const featureMs = performance.now() - featureT0;

    // Gate should skip in hybrid; direct call still must not hang after page-span fix.
    expect(shouldSkipReceiptAnalysisForContractDocument({ recognizedText: text, pageTexts: pages })).toBe(
      true,
    );

    const directT0 = performance.now();
    const direct = runReceiptAnalysisPipeline({ recognizedText: text, pageTexts: pages });
    const directMs = performance.now() - directT0;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        textLen: text.length,
        zoneMs: Math.round(zoneMs),
        featureMs: Math.round(featureMs),
        directPipelineMs: Math.round(directMs),
        directValid: direct?.valid ?? null,
      }),
    );

    expect(zoneMs).toBeLessThan(500);
    expect(featureMs).toBeLessThan(2_000);
    expect(directMs).toBeLessThan(3_000);
    expect(direct?.valid).toBe(true);
  }, 10_000);
});
