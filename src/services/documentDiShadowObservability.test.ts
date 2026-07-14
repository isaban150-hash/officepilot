import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DI_CUSTOMER_SCORING_REASON_KEY,
  setDiShadowObservabilityEnabledForTests,
} from '../config/documentIntelligenceConfig';
import {
  classifyDocument,
  detectClassifiedKindWithReason,
} from './documentClassificationService';
import { resolveHybridClassification } from './documentClassificationHybridService';
import {
  buildDiClassificationShadowRecord,
  buildDocumentFingerprint,
  runLegacyDocumentAnalysisShadow,
} from './documentAnalysisShadowService';
import {
  clearDiShadowLogForTests,
  readDiShadowLog,
} from './documentShadowPersistenceService';

const TANK_RECEIPT = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
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

const MAHNUNG_TEXT = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  '12345 Musterstadt',
  '2. Mahnung',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Offener Betrag: 1.247,80 EUR',
  'Zahlungsaufforderung',
  'Zahlbar bis 31.03.2026',
].join('\n');

const FINANZAMT_TEXT = [
  'Finanzamt München',
  'Musterstraße 1',
  '80331 München',
  'Betreff: Umsatzsteuervoranmeldung',
  'Aktenzeichen: 143/123/45678',
  'Datum: 15.02.2026',
  'Frist: 10.05.2026',
  'Lohnsteuer-Anmeldung Q1',
].join('\n');

const FREISTELLUNG_TEXT = [
  'Finanzamt München',
  'Freistellungsbescheinigung §48b',
  'Betreff: Freistellungsbescheinigung nach §48b EStG',
  'Aussteller: Finanzamt München',
  'Datum: 15.03.2026',
  'gültig bis 31.12.2027',
].join('\n');

const KUNDENAUFTRAG_TEXT = [
  'Müller Bau GmbH',
  'Kundenauftrag',
  'Betreff: Sanierung Fassade',
  'Auftraggeber: Stadt München',
  'Baustelle: Hauptstr. 12, 80331 München',
  'Auftragsnummer: KA-2026-0042',
  'Auftragssumme: 45.000,00 EUR',
  'Datum: 15.03.2026',
].join('\n');

const AMBIGUOUS_RECEIPT = ['Quittung', '42,80 EUR', 'Danke'].join('\n');

function buildShadowOptions(input: Parameters<typeof classifyDocument>[0]) {
  const legacyDetection = detectClassifiedKindWithReason(input);
  const hybridContext = resolveHybridClassification(input, legacyDetection);
  return { legacyDetection, hybridContext };
}

describe('documentDiShadowObservability', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = {
      store: new Map<string, string>(),
      get length() {
        return this.store.size;
      },
      clear() {
        this.store.clear();
      },
      key() {
        return null;
      },
      getItem(key: string) {
        return this.store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.store.set(key, value);
      },
      removeItem(key: string) {
        this.store.delete(key);
      },
    } as Storage;
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    clearDiShadowLogForTests(storage);
    setDiShadowObservabilityEnabledForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a sanitized shadow record for a productive cutover case', () => {
    const input = { recognizedText: TANK_RECEIPT };
    const classification = classifyDocument(input);
    const options = buildShadowOptions(input);
    const record = buildDiClassificationShadowRecord({
      classification,
      legacyDetection: options.legacyDetection,
      hybridContext: options.hybridContext,
      classificationInput: input,
    });

    expect(record.productiveKind).toBe('tankbeleg');
    expect(record.cutoverApplied).toBe(true);
    expect(record.cutoverLane).toBe('receipt');
    expect(record.laneEvaluations).toHaveLength(7);
    expect(record.laneEvaluations.find((entry) => entry.lane === 'receipt')?.eligible).toBe(true);
    expect(record.documentFingerprint).toHaveLength(64);
    expect(record.documentFingerprint).not.toContain('ARAL');
  });

  it('persists shadow records when observability is enabled', () => {
    setDiShadowObservabilityEnabledForTests(false);
    const input = { recognizedText: TANK_RECEIPT };
    const classification = classifyDocument(input);
    const options = buildShadowOptions(input);

    setDiShadowObservabilityEnabledForTests(true);
    clearDiShadowLogForTests(storage);
    runLegacyDocumentAnalysisShadow(classification, input, options);

    expect(readDiShadowLog(storage)).toHaveLength(1);
  });

  it('does not persist shadow records when observability is disabled', () => {
    setDiShadowObservabilityEnabledForTests(false);
    const input = { recognizedText: TANK_RECEIPT };
    const classification = classifyDocument(input);
    const options = buildShadowOptions(input);

    runLegacyDocumentAnalysisShadow(classification, input, options);

    expect(readDiShadowLog(storage)).toHaveLength(0);
  });

  it('does not change productive classification when observability is enabled', () => {
    setDiShadowObservabilityEnabledForTests(true);
    const withShadow = classifyDocument({ recognizedText: INVOICE_TEXT });
    setDiShadowObservabilityEnabledForTests(false);
    const withoutShadow = classifyDocument({ recognizedText: INVOICE_TEXT });

    expect(withShadow.classifiedKind).toBe(withoutShadow.classifiedKind);
    expect(withShadow.detectionReasonKey).toBe(withoutShadow.detectionReasonKey);
    expect(withShadow.recognizedData).toEqual(withoutShadow.recognizedData);
  });

  it('captures legacy fallback and lane near-miss metadata', () => {
    const input = { recognizedText: AMBIGUOUS_RECEIPT };
    const classification = classifyDocument(input);
    const options = buildShadowOptions(input);
    const record = buildDiClassificationShadowRecord({
      classification,
      legacyDetection: options.legacyDetection,
      hybridContext: options.hybridContext,
      classificationInput: input,
    });

    expect(record.cutoverApplied).toBe(false);
    expect(record.cutoverLane).toBe('legacy');
    expect(record.mismatchType).toBe('lane_near_miss');
    expect(
      record.laneEvaluations.some(
        (entry) => entry.lane === 'receipt' && !entry.eligible && Boolean(entry.rejectionReason),
      ),
    ).toBe(true);
  });

  it('uses lane-specific margins for customer cutover winners', () => {
    const input = { recognizedText: KUNDENAUFTRAG_TEXT };
    const classification = classifyDocument(input);
    const options = buildShadowOptions(input);
    const record = buildDiClassificationShadowRecord({
      classification,
      legacyDetection: options.legacyDetection,
      hybridContext: options.hybridContext,
      classificationInput: input,
    });
    const customerLane = record.laneEvaluations.find((entry) => entry.lane === 'customer');

    expect(classification.detectionReasonKey).toBe(DI_CUSTOMER_SCORING_REASON_KEY);
    expect(customerLane?.eligible).toBe(true);
    expect(customerLane?.winnerKind).toBe('auftrag');
    expect(customerLane?.laneMargin).toBeGreaterThan(0);
  });

  it('does not persist OCR text, PII, or evidence snippets', () => {
    setDiShadowObservabilityEnabledForTests(true);
    const secretText = [
      'Rechnung INV-SECRET-77',
      'Kunde: Geheime Firma GmbH',
      'Baustellenadresse: Geheime Straße 12',
      'IBAN: DE89 3704 0044 0532 0130 00',
      'geheime@firma.de',
      'Gesamtbetrag 1.247,80 EUR',
    ].join('\n');
    const input = { recognizedText: secretText, senderHint: 'Geheime Firma GmbH' };
    const classification = classifyDocument(input);
    const options = buildShadowOptions(input);

    runLegacyDocumentAnalysisShadow(classification, input, options);

    const serialized = storage.getItem('officepilot:di-shadow-log') ?? '';
    expect(serialized).not.toContain('INV-SECRET-77');
    expect(serialized).not.toContain('Geheime Firma GmbH');
    expect(serialized).not.toContain('geheime@firma.de');
    expect(serialized).not.toContain('DE89 3704 0044 0532 0130 00');
    expect(serialized).not.toContain('Geheime Straße');
    expect(serialized).not.toContain('snippet');
  });

  it('builds fingerprints without OCR payload content', () => {
    const fingerprint = buildDocumentFingerprint({
      recognizedText: 'Geheime Rechnung INV-SECRET-77',
      senderHint: 'Geheime Firma GmbH',
      kindHint: 'eingangsrechnung',
    });

    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).not.toContain('INV-SECRET-77');
    expect(fingerprint).not.toContain('Geheime');
  });
});
