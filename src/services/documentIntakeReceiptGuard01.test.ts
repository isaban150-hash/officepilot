/**
 * DOCUMENT-INTAKE-RECEIPT-GUARD-01 — gate, shadow skip, zoning hang fix, WV full intake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
  SAMPLE_EINGANGSRECHNUNG_TEXT,
} from '../test/werkvertragMultiSectionFixtures';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { hydrateInboxStore } from './inboxService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { processUploadedDocument } from './intakeWorkflowService';
import { shouldSkipReceiptAnalysisForContractDocument } from './documentReceiptAnalysisGate';
import * as receiptPipeline from './documentReceiptAnalysisPipelineService';
import {
  getReceiptPipelineInvocationCountForTests,
  resetReceiptPipelineCountersForTests,
  runReceiptAnalysisPipeline,
} from './documentReceiptAnalysisPipelineService';
import {
  buildCanonicalDocumentText,
  buildPageSpansForTests,
  zoneDocumentText,
} from './documentZoningService';
import { extractDocumentFeatures } from './documentFeatureExtractionService';
import { resolveHybridClassification } from './documentClassificationHybridService';
import {
  classifyDocument,
  detectClassifiedKindWithReason,
} from './documentClassificationService';
import {
  resetLegacyAnalysisShadowInvocationCountForTests,
  runLegacyDocumentAnalysisShadow,
} from './documentAnalysisShadowService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { assertDocumentCase } from '../test/document-cases/_lib/assertCase';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';

const HOTEL_TEXT = `
Hotelrechnung
Hotel: City Lodge Berlin GmbH
Gast: Max Mustermann
Aufenthalt: 10.03.2026 – 12.03.2026
Rechnungsnummer: HOT-77821
Betrag: 278,80 €
Gesamtbetrag: 278,80 €
`.trim();

const LONG_INVOICE_WITH_POSITIONS = `
Rechnung
Lieferant: Bürobedarf GmbH
Rechnungsnummer: RE-2026-88421
Rechnungsdatum: 15.03.2026
Pos  Menge  Einheit  Bezeichnung                 Betrag
1    10     Stk      Ordner A4                     49,90 €
2    5      Pauschal Toner schwarz                 89,00 €
3    20     Stk      Kugelschreiber blau           12,40 €
4    3      Stk      Briefumschläge DL             7,80 €
5    1      Stk      Schreibtischlampe             34,50 €
Zwischensumme: 193,60 €
MwSt 19%: 36,78 €
Gesamtbetrag: 230,38 €
Zahlungsziel: 14 Tage
`.trim();

const ANGEBOT_TEXT = `
Angebot Nr. A-4412
Sehr geehrte Damen und Herren,
hiermit unterbreiten wir Ihnen folgendes Angebot für Malerarbeiten.
Leistungsumfang nach Absprache.
Gesamtnetto: 4.200,00 €
`.trim();

const AUFTRAGSBESTAETIGUNG_TEXT = `
Auftragsbestätigung
Vielen Dank für Ihren Auftrag vom 01.03.2026.
Wir bestätigen die Ausführung der vereinbarten Leistungen.
Liefertermin: KW 12
`.trim();

/**
 * Pre-fix loop: after finding nextMatch, rewind lastIndex to nextMatch.index.
 * That re-executes the same marker forever.
 */
function runBuggyPageSpanLoop(text: string, maxIterations: number): number {
  const markerPattern = /---SEITE\s+(\d+)---/gi;
  if (!markerPattern.test(text)) return 0;
  markerPattern.lastIndex = 0;
  let match = markerPattern.exec(text);
  let iterations = 0;
  while (match && iterations < maxIterations) {
    const nextMatch = markerPattern.exec(text);
    if (nextMatch) markerPattern.lastIndex = nextMatch.index;
    match = nextMatch;
    iterations += 1;
  }
  return iterations;
}

describe('DOCUMENT-INTAKE-RECEIPT-GUARD-01', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    resetReceiptPipelineCountersForTests();
    resetLegacyAnalysisShadowInvocationCountForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildPageSpans advances past full markers (edge cases + hang reproduction)', () => {
    const unix = '---SEITE 1---\nAlpha\n---SEITE 2---\nBeta\n---SEITE 3---\nGamma';
    const crlf = '---SEITE 1---\r\nAlpha\r\n---SEITE 2---\r\nBeta';
    const consecutive = '---SEITE 1------SEITE 2---\nOnly page 2 body';
    const invalidThenValid = '---SEITE x---\nbad\n---SEITE 2---\nok';
    const preamble = 'Cover note\n---SEITE 1---\nBody one\n---SEITE 2---\nBody two';

    const unixSpans = buildPageSpansForTests(unix);
    expect(unixSpans.map((s) => s.pageNumber)).toEqual([1, 2, 3]);
    expect(unix.slice(unixSpans[0]!.startOffset, unixSpans[0]!.endOffset)).toContain('Alpha');
    expect(unix.slice(unixSpans[1]!.startOffset, unixSpans[1]!.endOffset)).toContain('Beta');
    expect(unix.slice(unixSpans[2]!.startOffset, unixSpans[2]!.endOffset)).toContain('Gamma');
    expect(unixSpans.every((s) => s.endOffset > s.startOffset)).toBe(true);

    const crlfSpans = buildPageSpansForTests(crlf);
    expect(crlfSpans.map((s) => s.pageNumber)).toEqual([1, 2]);
    expect(crlf.slice(crlfSpans[0]!.startOffset, crlfSpans[0]!.endOffset)).toContain('Alpha');

    // Consecutive markers: empty span between 1→2 is dropped; page 2 keeps body.
    const consecSpans = buildPageSpansForTests(consecutive);
    expect(consecSpans.every((s) => s.endOffset > s.startOffset)).toBe(true);
    const page2 = consecSpans.find((s) => s.pageNumber === 2);
    expect(page2).toBeDefined();
    expect(consecutive.slice(page2!.startOffset, page2!.endOffset)).toContain('Only page 2 body');

    // Non-numeric "SEITE x" is not a marker; page 2 + optional preamble keep content.
    const invalidSpans = buildPageSpansForTests(invalidThenValid);
    expect(
      invalidSpans.some((s) => invalidThenValid.slice(s.startOffset, s.endOffset).includes('ok')),
    ).toBe(true);
    expect(
      invalidSpans.some((s) => invalidThenValid.slice(s.startOffset, s.endOffset).includes('bad')),
    ).toBe(true);

    const preambleSpans = buildPageSpansForTests(preamble);
    expect(preambleSpans[0]!.pageNumber).toBe(1);
    expect(preamble.slice(preambleSpans[0]!.startOffset, preambleSpans[0]!.endOffset)).toContain(
      'Cover note',
    );
    expect(preambleSpans.at(-1)!.pageNumber).toBe(2);
    expect(
      preamble.slice(preambleSpans.at(-1)!.startOffset, preambleSpans.at(-1)!.endOffset),
    ).toContain('Body two');

    // Fixed impl terminates under budget on WV-style multipage markers.
    const pages = buildSyntheticWerkvertragPages();
    const wvText = buildCanonicalDocumentText(buildSyntheticWerkvertragText(), pages);
    const t0 = performance.now();
    const wvSpans = buildPageSpansForTests(wvText);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(wvSpans.length).toBeGreaterThan(1);
    expect(wvSpans.every((s) => s.endOffset > s.startOffset)).toBe(true);

    // Without the fix: same marker text hits the iteration cap (would hang forever).
    const maxIterations = 5_000;
    expect(runBuggyPageSpanLoop(unix, maxIterations)).toBe(maxIterations);
    // Fixed path: three markers → finite spans, not an iteration bomb.
    expect(buildPageSpansForTests(unix).length).toBe(3);
  });

  it('zoneDocumentText returns on multipage WV markers (no infinite loop)', () => {
    const pages = buildSyntheticWerkvertragPages();
    const text = buildCanonicalDocumentText(buildSyntheticWerkvertragText(), pages);
    const t0 = performance.now();
    const zoned = zoneDocumentText(text, pages);
    const ms = performance.now() - t0;
    expect(zoned.lines.length).toBeGreaterThan(5);
    expect(ms).toBeLessThan(1_000);
    const featureMs = (() => {
      const start = performance.now();
      extractDocumentFeatures(zoned);
      return performance.now() - start;
    })();
    expect(featureMs).toBeLessThan(2_000);
  });

  it('does not skip long invoices, hotel, Angebot, or Auftragsbestätigung', () => {
    expect(
      shouldSkipReceiptAnalysisForContractDocument({
        recognizedText: SAMPLE_EINGANGSRECHNUNG_TEXT,
      }),
    ).toBe(false);
    expect(
      shouldSkipReceiptAnalysisForContractDocument({
        recognizedText: HOTEL_TEXT,
      }),
    ).toBe(false);
    expect(
      shouldSkipReceiptAnalysisForContractDocument({
        recognizedText: LONG_INVOICE_WITH_POSITIONS,
      }),
    ).toBe(false);
    expect(
      shouldSkipReceiptAnalysisForContractDocument({
        recognizedText: ANGEBOT_TEXT,
      }),
    ).toBe(false);
    expect(
      shouldSkipReceiptAnalysisForContractDocument({
        recognizedText: AUFTRAGSBESTAETIGUNG_TEXT,
      }),
    ).toBe(false);
    expect(
      shouldSkipReceiptAnalysisForContractDocument({
        recognizedText: 'Dies ist ein Vertrag über allgemeine Leistungen ohne LV.',
      }),
    ).toBe(false);

    resetReceiptPipelineCountersForTests();
    const erPipeline = runReceiptAnalysisPipeline({
      recognizedText: SAMPLE_EINGANGSRECHNUNG_TEXT,
    });
    expect(erPipeline?.valid).toBe(true);
    expect(getReceiptPipelineInvocationCountForTests()).toBe(1);

    const hotelPipeline = runReceiptAnalysisPipeline({ recognizedText: HOTEL_TEXT });
    expect(hotelPipeline?.valid).toBe(true);
    expect(getReceiptPipelineInvocationCountForTests()).toBe(2);
  });

  it('skips receipt analysis for strong Werkvertrag+LV when contract cutover is off', async () => {
    const { setContractScoringCutoverEnabledForTests } = await import(
      '../config/documentIntelligenceConfig'
    );
    setContractScoringCutoverEnabledForTests(false);
    try {
      const pages = buildSyntheticWerkvertragPages();
      const text = buildSyntheticWerkvertragText();
      expect(
        shouldSkipReceiptAnalysisForContractDocument({
          recognizedText: text,
          pageTexts: pages,
        }),
      ).toBe(true);

      const hybrid = resolveHybridClassification(
        { recognizedText: text, pageTexts: pages, sourceFileName: 'WV.pdf' },
        detectClassifiedKindWithReason({
          recognizedText: text,
          pageTexts: pages,
          sourceFileName: 'WV.pdf',
        }),
      );
      expect(hybrid.pipelineDecision).toBe('skipped_contract');
      expect(hybrid.pipeline).toBeNull();
    } finally {
      setContractScoringCutoverEnabledForTests(null);
    }
  });

  it('shadow does not reinvent receipt pipeline after intentional contract skip', async () => {
    const { setContractScoringCutoverEnabledForTests } = await import(
      '../config/documentIntelligenceConfig'
    );
    setContractScoringCutoverEnabledForTests(false);
    try {
      const pages = buildSyntheticWerkvertragPages();
      const text = buildSyntheticWerkvertragText();
      const input = { recognizedText: text, pageTexts: pages, sourceFileName: 'WV.pdf' };
      const legacy = detectClassifiedKindWithReason(input);
      const hybrid = resolveHybridClassification(input, legacy);
      expect(hybrid.pipelineDecision).toBe('skipped_contract');

      const runSpy = vi.spyOn(receiptPipeline, 'runReceiptAnalysisPipeline');
      const classification = classifyDocument(input);

      runLegacyDocumentAnalysisShadow(classification, input, {
        legacyDetection: legacy,
        hybridContext: hybrid,
      });

      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      setContractScoringCutoverEnabledForTests(null);
    }
  });

  it('WV-LV-01 full processUploadedDocument completes with CI+BI; receipt not re-run on kindHint', () => {
    const docCase = getDocumentCase('WV-LV-01');
    const pages = docCase.pages ?? buildSyntheticWerkvertragPages();
    const text = docCase.ocrText;

    resetReceiptPipelineCountersForTests();
    const t0 = performance.now();

    const item = createMockInboxItemFromUpload({
      sourceFileName: 'WV-LV-01.pdf',
      recognizedText: text,
      pageTexts: pages,
      titleHint: docCase.scenario.titleHint,
      senderHint: docCase.scenario.senderHint,
      importSource: 'upload',
    });
    const hydrated = {
      ...item,
      id: 'inbox-case-WV-LV-01-full',
      markedAsCompanyDocument: true,
      recognizedData: {
        ...item.recognizedData,
        _extractedText: text,
        _vertragstext: text,
        _pageTexts: JSON.stringify(pages),
      },
    };
    hydrateInboxStore([hydrated]);

    const beforeIntake = getReceiptPipelineInvocationCountForTests();
    const workflow = processUploadedDocument(hydrated.id);
    const afterIntake = getReceiptPipelineInvocationCountForTests();
    const elapsed = performance.now() - t0;

    expect(workflow).not.toBeNull();
    expect(workflow!.contractIntelligence).not.toBeNull();
    expect(workflow!.businessInterpretation).not.toBeNull();
    expect(workflow!.classifiedKind).toMatch(/werkvertrag|subunternehmervertrag/);
    expect(workflow!.suggestedOrderPositions.length).toBeGreaterThanOrEqual(10);
    expect(workflow!.businessInterpretation!.operational.primaryCase).toMatch(
      /possible_new_order|contract_proposed/,
    );
    // Upload may run pipeline once (contract cutover); intake reclassify must not invent another.
    expect(beforeIntake).toBeLessThanOrEqual(1);
    expect(afterIntake).toBe(beforeIntake);
    expect(elapsed).toBeLessThan(10_000);

    assertDocumentCase(docCase.expected, {
      item: hydrated,
      workflow: workflow!,
      bi: workflow!.businessInterpretation,
      usedSpecialistPath: false,
    });
  }, 15_000);

  it('keeps specialist WV-LV path as additional regression', () => {
    const docCase = getDocumentCase('WV-LV-01');
    const observation = runStablePipeline(docCase);
    expect(observation.usedSpecialistPath).toBe(true);
    assertDocumentCase(docCase.expected, observation);
  });
});
