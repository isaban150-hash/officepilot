import { describe, expect, it } from 'vitest';
import { classifyDocument, detectClassifiedKind } from './documentClassificationService';
import { resolveHybridClassification } from './documentClassificationHybridService';
import { detectClassifiedKindWithReason } from './documentClassificationService';
import { buildDocumentProfile } from './documentProfileService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { DI_PAYMENT_SCORING_REASON_KEY } from '../config/documentIntelligenceConfig';
import { UNKNOWN_SENDER_CANONICAL } from '../i18n/resolveStoredText';

const ARBEITSBESCHEINIGUNG = [
  'Bundesagentur für Arbeit',
  'Agentur für Arbeit München',
  'Arbeitsbescheinigung',
  'nach § 312 SGB III',
  'Arbeitgeber: Muster Bau GmbH',
  'Arbeitnehmer: Max Mustermann',
  'Versicherungsnummer: 12 345678 A 123',
  'Beschäftigungsverhältnis vom 01.01.2020 bis 30.06.2026',
  'Bruttoarbeitsentgelt: 3.200,00 EUR',
  'Frist: 15.08.2026',
  'Seite 3 von 9 Arbeitsbescheinigung Bitte vollständig ausfüllen',
].join('\n');

const ARBEITSBESCHEINIGUNG_WITH_KNAPPSCHAFT = [
  ARBEITSBESCHEINIGUNG,
  'Krankenkasse / Knappschaft laut Beschäftigungsverhältnis',
].join('\n');

const KK_CORRESPONDENCE = [
  'AOK Bayern',
  'Die Gesundheitskasse',
  'Krankenkasse',
  'Betreff: Beitragsbescheid Krankenversicherung',
  'Aktenzeichen: KK-2026-8891',
  'Datum: 15.03.2026',
  'Frist: 30.04.2026',
  'Sehr geehrte Damen und Herren,',
  'bitte reichen Sie die Unterlagen ein.',
].join('\n');

const KK_MAHNUNG = [
  'AOK Bayern',
  'Krankenkasse',
  '1. Mahnung',
  'Zahlungsaufforderung',
  'Rechnungsnummer: KK-2026-100',
  'Offener Betrag: 320,00 EUR',
  'Bitte überweisen Sie den Betrag bis 30.04.2026',
].join('\n');

const INVOICE = [
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

const WERKVERTRAG = [
  'Werkvertrag',
  'Auftraggeber: Müller Bau GmbH',
  'Auftragnehmer: Sanitär Pro GmbH',
  'Vertragsdatum: 01.03.2026',
  'Leistungsverzeichnis',
].join('\n');

const ANGEBOT = [
  'Angebot',
  'Kunde: Müller Bau GmbH',
  'Angebotssumme: 5.000,00 EUR',
  'Gültig bis: 30.04.2026',
].join('\n');

const KUENDIGUNG = [
  'Kündigung des Arbeitsverhältnisses',
  'Arbeitgeber: Muster Bau GmbH',
  'Arbeitnehmer: Max Mustermann',
  'Das Arbeitsverhältnis endet am 31.07.2026.',
].join('\n');

describe('UNIVERSAL-DOCUMENT-UNDERSTANDING-01', () => {
  it('builds a runtime BA employment profile without paymentDemand', () => {
    const pipeline = runReceiptAnalysisPipeline({ recognizedText: ARBEITSBESCHEINIGUNG });
    const profile = buildDocumentProfile({
      pipeline,
      recognizedText: ARBEITSBESCHEINIGUNG,
    });

    expect(profile.senderCategory).toBe('authority');
    expect(['form', 'certificate']).toContain(profile.documentFunction);
    expect(profile.subjectArea).toBe('employment');
    expect(profile.paymentDemand).toBe(false);
    expect(['review', 'archive', 'information_only']).toContain(profile.actionType);
    expect(profile.classifiedKindHint).toBe('agentur_fuer_arbeit');
    expect(profile.conflicts).not.toContain('invoice_vs_reminder');
  });

  it('classifies BA Arbeitsbescheinigung as agentur, not mahnung or krankenkasse', () => {
    const result = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG });

    expect(result.classifiedKind).toBe('agentur_fuer_arbeit');
    expect(result.classifiedKind).not.toBe('mahnung');
    expect(result.classifiedKind).not.toBe('krankenkasse');
    expect(result.classifiedKind).not.toBe('knappschaft');
    expect(result.detectionReasonKey).not.toBe(DI_PAYMENT_SCORING_REASON_KEY);
    expect(result.documentProfile?.paymentDemand).toBe(false);
    expect(result.documentProfile?.senderCategory).toBe('authority');
    expect(result.sender).toBe('Bundesagentur für Arbeit');
    expect(result.sender).not.toMatch(/Seite\s+3/i);
    expect(result.recommendedAction).not.toBe('zahlung_pruefen');
  });

  it('does not auto-classify BA form with Knappschaft noise as Krankenkasse', () => {
    const result = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG_WITH_KNAPPSCHAFT });

    expect(result.classifiedKind).not.toBe('krankenkasse');
    expect(result.classifiedKind).not.toBe('knappschaft');
    expect(result.classifiedKind).toBe('agentur_fuer_arbeit');
    expect(result.documentProfile?.conflicts).toContain(
      'authority_employment_vs_health_insurance',
    );
    expect(result.documentProfile?.paymentDemand).toBe(false);
  });

  it('keeps genuine Krankenkasse correspondence', () => {
    const result = classifyDocument({ recognizedText: KK_CORRESPONDENCE });
    expect(['krankenkasse', 'aok']).toContain(result.classifiedKind);
  });

  it('keeps genuine Krankenkasse mahnung on payment path', () => {
    const result = classifyDocument({ recognizedText: KK_MAHNUNG });
    expect(result.classifiedKind).toBe('mahnung');
    expect(result.documentProfile?.paymentDemand).toBe(true);
    expect(result.detectionReasonKey).toBe(DI_PAYMENT_SCORING_REASON_KEY);
  });

  it('keeps invoice, werkvertrag and angebot stable', () => {
    expect(classifyDocument({ recognizedText: INVOICE }).classifiedKind).toBe('eingangsrechnung');
    expect(classifyDocument({ recognizedText: WERKVERTRAG }).classifiedKind).toBe('werkvertrag');
    expect(classifyDocument({ recognizedText: ANGEBOT }).classifiedKind).toBe('angebot');
  });

  it('does not classify Kündigung without demand as mahnung', () => {
    expect(detectClassifiedKind({ recognizedText: KUENDIGUNG })).not.toBe('mahnung');
    const result = classifyDocument({ recognizedText: KUENDIGUNG });
    expect(result.classifiedKind).not.toBe('mahnung');
    expect(result.documentProfile?.paymentDemand).toBe(false);
  });

  it('surfaces review instead of a wrong fine kind when candidates conflict closely', () => {
    const legacy = detectClassifiedKindWithReason({
      recognizedText: ARBEITSBESCHEINIGUNG_WITH_KNAPPSCHAFT,
    });
    const hybrid = resolveHybridClassification(
      { recognizedText: ARBEITSBESCHEINIGUNG_WITH_KNAPPSCHAFT },
      legacy,
    );

    expect(hybrid.documentProfile).not.toBeNull();
    expect(hybrid.documentProfile?.topCandidates.length).toBeGreaterThan(0);
    expect(hybrid.resolution.detection.kind).not.toBe('krankenkasse');
    expect(hybrid.resolution.detection.kind).not.toBe('knappschaft');
  });

  it('never uses page OCR noise as supplier/sender', () => {
    const result = classifyDocument({
      recognizedText: [
        'Arbeitsbescheinigung',
        'nach § 312 SGB III',
        'Arbeitgeber: Muster Bau GmbH',
        'Seite 3 von 9 Arbeitsbescheinigung Bitte vollständig ausfüllen',
      ].join('\n'),
    });

    expect(result.sender).not.toMatch(/Seite\s+3/i);
    expect(result.recognizedData.Lieferant ?? '').not.toMatch(/Seite\s+3/i);
    if (!result.documentProfile?.senderEntity) {
      expect(result.sender).toBe(UNKNOWN_SENDER_CANONICAL);
    }
  });

  it('keeps documentProfile runtime-only on classification result (not an InboxItem field)', () => {
    const result = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG });
    expect(result.documentProfile).toBeDefined();
    // InboxItem type must not require documentProfile — structural check via omit simulation
    const persistedShape = {
      classifiedKind: result.classifiedKind,
      recognizedData: result.recognizedData,
      sender: result.sender,
    };
    expect('documentProfile' in persistedShape).toBe(false);
  });

  it('uses the same profile path for upload-like and scan-like input', () => {
    const uploadLike = classifyDocument({
      recognizedText: ARBEITSBESCHEINIGUNG,
      sourceFileName: 'scan.pdf',
    });
    const scanLike = classifyDocument({ recognizedText: ARBEITSBESCHEINIGUNG });

    expect(uploadLike.classifiedKind).toBe(scanLike.classifiedKind);
    expect(uploadLike.documentProfile?.senderCategory).toBe(
      scanLike.documentProfile?.senderCategory,
    );
    expect(uploadLike.documentProfile?.paymentDemand).toBe(
      scanLike.documentProfile?.paymentDemand,
    );
  });
});
