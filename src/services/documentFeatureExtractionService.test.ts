import { describe, expect, it, vi } from 'vitest';
import { classifyDocument } from './documentClassificationService';
import {
  extractDocumentFeatures,
  mergeFeatureEvidenceIndex,
  validateFeatureExtractionResult,
} from './documentFeatureExtractionService';
import {
  buildCanonicalDocumentText,
  buildEvidenceIndex,
  zoneDocumentText,
  zoneText,
} from './documentZoningService';
import { resetLegacyAnalysisShadowInvocationCountForTests } from './documentAnalysisShadowService';
import { isValidEvidenceRef } from '../types/documentAnalysis';
import { buildPageMarker } from './documentSegmentationService';

const AUTHORITY_LETTER = [
  'Finanzamt Musterstadt',
  'Absender: Finanzamt Musterstadt',
  'Empfänger: Müller Bau GmbH',
  'Betreff: Umsatzsteuervoranmeldung',
  'Sehr geehrte Damen und Herren,',
  'bitte reichen Sie die Unterlagen bis 30.06.2026 ein.',
  'Frist: 30.06.2026',
  'Aktenzeichen: FA-2026-77',
  'Mit freundlichen Grüßen',
  'Finanzamt Musterstadt',
  'HRB 12345 Amtsgericht Musterstadt',
  'Geschäftsführer: Max Mustermann',
].join('\n');

const INVOICE_TEXT = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  '12345 Musterstadt',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Leistung: Sanierung Dach',
  'Gesamtbetrag 1.247,80 EUR',
  'IBAN: DE89 3704 0044 0532 0130 00',
  'zahlbar bis 31.03.2026',
].join('\n');

describe('documentFeatureExtractionService', () => {
  it('extracts labeled identity features with header zones and evidence', () => {
    const zoned = zoneText(AUTHORITY_LETTER);
    const result = extractDocumentFeatures(zoned);

    const sender = result.features.find((feature) => feature.id === 'identity.sender_labeled');
    const recipient = result.features.find((feature) => feature.id === 'identity.recipient_labeled');

    expect(sender?.zone).toBe('header');
    expect(sender?.strength).toBe('strong');
    expect(sender?.value).toBe('Finanzamt Musterstadt');
    expect(recipient?.value).toBe('Müller Bau GmbH');
    expect(sender?.evidenceRefs[0]).toMatch(/^feature:identity\.sender_labeled:\d+$/);
    expect(isValidEvidenceRef(result.evidenceIndex[sender!.evidenceRefs[0]!])).toBe(true);
  });

  it('extracts document and deadline dates with OCR evidence', () => {
    const zoned = zoneText(AUTHORITY_LETTER);
    const result = extractDocumentFeatures(zoned);

    const documentDates = result.features.filter((feature) => feature.id === 'date.document_date');
    const deadline = result.features.find((feature) => feature.id === 'date.deadline_date');

    expect(documentDates.length).toBeGreaterThan(0);
    expect(deadline?.value).toBe('30.06.2026');
    expect(deadline?.strength).toBe('strong');
    expect(deadline?.evidenceRefs.every((refId) => refId in result.evidenceIndex)).toBe(true);
  });

  it('extracts invoice and case references in the body zone', () => {
    const zoned = zoneText(INVOICE_TEXT);
    const result = extractDocumentFeatures(zoned);

    const invoiceNumber = result.features.find((feature) => feature.id === 'reference.invoice_number');
    expect(invoiceNumber?.value).toBe('INV-2026-77');
    expect(invoiceNumber?.zone).toBe('body');
    expect(invoiceNumber?.strength).toBe('strong');

    const zonedAuthority = zoneText(AUTHORITY_LETTER);
    const authorityResult = extractDocumentFeatures(zonedAuthority);
    const caseReference = authorityResult.features.find((feature) => feature.id === 'reference.case_reference');
    expect(caseReference?.value).toBe('FA-2026-77');
    expect(caseReference?.zone).toBe('body');
  });

  it('extracts monetary values and labeled totals from OCR text', () => {
    const zoned = zoneText(INVOICE_TEXT);
    const result = extractDocumentFeatures(zoned);

    const monetaryValues = result.features.filter((feature) => feature.id === 'amount.monetary_value');
    const labeledTotal = result.features.find((feature) => feature.id === 'amount.labeled_total');

    expect(monetaryValues.some((feature) => feature.value === 1247.8)).toBe(true);
    expect(monetaryValues.every((feature) => feature.zone === 'body')).toBe(true);
    expect(labeledTotal).toBeUndefined();
  });

  it('extracts payment IBAN markers with normalized value', () => {
    const zoned = zoneText(INVOICE_TEXT);
    const result = extractDocumentFeatures(zoned);
    const iban = result.features.find((feature) => feature.id === 'payment.iban');

    expect(iban?.value).toBe('DE89370400440532013000');
    expect(iban?.category).toBe('payment');
    expect(iban?.evidenceRefs[0]).toMatch(/^feature:payment\.iban:\d+$/);
  });

  it('marks footer register features as weak while keeping evidence in the footer zone', () => {
    const zoned = zoneText(AUTHORITY_LETTER);
    const result = extractDocumentFeatures(zoned);

    const hrb = result.features.find((feature) => feature.id === 'register.hrb_hra_number');
    const court = result.features.find((feature) => feature.id === 'register.court_marker');
    const director = result.features.find((feature) => feature.id === 'register.managing_director_marker');

    expect(hrb?.zone).toBe('footer');
    expect(hrb?.strength).toBe('weak');
    expect(court?.zone).toBe('footer');
    expect(court?.strength).toBe('weak');
    expect(director?.value).toBe('Max Mustermann');
    expect(director?.strength).toBe('weak');
  });

  it('detects structural payment requests and authority-letter markers', () => {
    const authorityResult = extractDocumentFeatures(zoneText(AUTHORITY_LETTER));
    const invoiceResult = extractDocumentFeatures(zoneText(INVOICE_TEXT));

    expect(authorityResult.features.some((feature) => feature.id === 'structure.authority_letter')).toBe(true);
    expect(invoiceResult.features.some((feature) => feature.id === 'structure.payment_request')).toBe(true);
  });

  it('detects short receipt layout features in the body without footer dominance', () => {
    const receipt = ['ARAL Tankstelle', 'Diesel 52,18 EUR', 'Danke'].join('\n');
    const result = extractDocumentFeatures(zoneText(receipt));
    const receiptLayout = result.features.find((feature) => feature.id === 'structure.receipt_layout');
    const amount = result.features.find((feature) => feature.id === 'amount.monetary_value');

    expect(receiptLayout?.zone).toBe('body');
    expect(receiptLayout?.value).toBe(true);
    expect(amount?.value).toBe(52.18);
    expect(result.features.some((feature) => feature.id === 'register.hrb_hra_number')).toBe(false);
  });

  it('keeps page numbers on feature evidence for multi-page OCR text', () => {
    const pageTexts = [
      { pageNumber: 1, text: 'Rechnungsnummer: P1-77' },
      { pageNumber: 2, text: 'Gesamtbetrag 99,00 EUR' },
    ];
    const canonical = buildCanonicalDocumentText(undefined, pageTexts);
    const zoned = zoneDocumentText(canonical, pageTexts);
    const result = extractDocumentFeatures(zoned);

    expect(canonical).toContain(buildPageMarker(2).trim());
    const pageTwoEvidence = Object.values(result.evidenceIndex).find(
      (entry) => entry.pageNumber === 2 && /99,00/.test(entry.snippet),
    );
    expect(pageTwoEvidence?.pageNumber).toBe(2);
  });

  it('validates feature extraction output and merges with zone evidence', () => {
    const zoned = zoneText(INVOICE_TEXT);
    const zoneEvidence = buildEvidenceIndex(zoned);
    const featureResult = extractDocumentFeatures(zoned);
    const merged = mergeFeatureEvidenceIndex(zoneEvidence, featureResult);

    expect(validateFeatureExtractionResult(featureResult)).toBe(true);
    expect(Object.keys(merged).length).toBeGreaterThan(Object.keys(zoneEvidence).length);
    expect(featureResult.features.every((feature) => feature.source === 'rules')).toBe(true);
  });

  it('does not change productive classification when shadow feature extraction runs', () => {
    resetLegacyAnalysisShadowInvocationCountForTests();
    const result = classifyDocument({
      recognizedText: AUTHORITY_LETTER,
      senderHint: 'Finanzamt Musterstadt',
    });

    expect(result.classifiedKind).toBe('finanzamt');
    expect(result.sender).toBe('Finanzamt Musterstadt');
  });

  it('extracts contract party markers and contract dates with zone-aware evidence', () => {
    const bodyFiller = Array.from({ length: 22 }, (_, index) => `Position ${index + 1} Leistungsbeschreibung`);
    const headerPartyText = [
      'Werkvertrag',
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Vertragsdatum: 15.03.2026',
      'Leistungsverzeichnis',
      ...bodyFiller,
      'Unterschrift Auftraggeber',
      'Ort, Datum: ___________',
    ].join('\n');
    const headerResult = extractDocumentFeatures(zoneText(headerPartyText));
    const headerParty = headerResult.features.find((feature) => feature.id === 'structure.contract_party_marker');
    const headerDate = headerResult.features.find((feature) => feature.id === 'date.contract_date');

    expect(headerParty?.zone).toBe('header');
    expect(headerParty?.strength).toBe('medium');
    expect(headerDate?.zone).toBe('header');
    expect(headerDate?.value).toBe('15.03.2026');

    const bodyPartyText = [
      'Werkvertrag',
      'Auftraggeber: Müller Bau GmbH',
      'Leistungsverzeichnis',
      ...bodyFiller.slice(0, 8),
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Vertragsdatum: 20.02.2026',
      ...bodyFiller.slice(8),
      'Unterschrift Auftraggeber',
      'Ort, Datum: ___________',
    ].join('\n');
    const bodyResult = extractDocumentFeatures(zoneText(bodyPartyText));
    const bodyParty = bodyResult.features.filter((feature) => feature.id === 'structure.contract_party_marker');
    const bodyDate = bodyResult.features.find((feature) => feature.id === 'date.contract_date');

    expect(bodyParty.some((feature) => feature.zone === 'body' && feature.rawValue.includes('Subunternehmer'))).toBe(true);
    expect(bodyDate?.zone).toBe('body');
    expect(bodyDate?.value).toBe('20.02.2026');

    const footerPartyText = [
      'Werkvertrag',
      'Auftraggeber: Müller Bau GmbH',
      'Vertragsdatum: 15.03.2026',
      'Leistungsverzeichnis',
      ...bodyFiller,
      'Subunternehmer: Mustermann Sanitär GmbH',
      'Unterschrift Auftraggeber',
      'Ort, Datum: 01.07.2026',
    ].join('\n');
    const footerResult = extractDocumentFeatures(zoneText(footerPartyText));
    const footerParty = footerResult.features.find(
      (feature) => feature.id === 'structure.contract_party_marker' && feature.zone === 'footer',
    );
    const footerContractDates = footerResult.features.filter(
      (feature) => feature.id === 'date.contract_date' && feature.zone === 'footer',
    );

    expect(footerParty?.rawValue).toContain('Subunternehmer');
    expect(footerContractDates).toHaveLength(0);
    expect(
      footerResult.features.some(
        (feature) => feature.id === 'date.contract_date' && feature.value === '01.07.2026',
      ),
    ).toBe(false);
  });

  it('does not log document contents during feature extraction in shadow mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    classifyDocument({
      recognizedText: 'Rechnung INV-SECRET-77 IBAN DE89 3704 0044 0532 0130 00',
      senderHint: 'Geheime Firma GmbH',
    });

    const logged = [...logSpy.mock.calls, ...debugSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .join(' ');
    expect(logged).not.toContain('INV-SECRET-77');
    expect(logged).not.toContain('Geheime Firma GmbH');

    logSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
