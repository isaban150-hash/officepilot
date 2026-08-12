/**
 * GOLD-LETTERHEAD-INITIALS-01 — eine vorangestellte Logo-Initiale darf nicht als Teil
 * des Organisationsnamens in ein Feld gelangen.
 *
 * Betroffen sind drei Verbrauchsstellen einer rohen Briefkopfzeile:
 *   - inferMerchantFromHeader   (Beleg-/Merchant-Pfad)
 *   - applyAuthorityOcrSender   (Behörden-recognizedData)
 *   - deriveSenderEntity        (Dokumentprofil-Sender)
 * Alle drei nutzen jetzt dieselbe bestehende Bereinigung cleanLetterheadCandidate.
 * Das Strukturmerkmal structure.authority_letter bleibt absichtlich roh.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setOcrOnlyRecognizedDataEnabledForTests } from '../config/documentIntelligenceConfig';
import { cleanLetterheadCandidate } from './documentFieldExtractionService';
import { buildEvidenceBasedRecognizedData } from './documentRecognizedDataService';
import { buildDocumentProfile } from './documentProfileService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';

const TANKBELEG_TEXT = [
  'A Aral Station Nord',
  'Tankstelle',
  'Vlothoer Str. 55 · 32105 Bad Salzuflen',
  'Kundenbeleg / Tankbeleg',
  'Datum 10.02.2026 · Beleg 884421',
  'Diesel 52,40 l 1,689 €/l 88,50 €',
  'Gesamtbetrag 92,95 €',
].join('\n');

const FINANZAMT_TEXT = [
  'F Finanzamt Detmold',
  'Behördenschreiben',
  'Büchenstraße 6 · 32756 Detmold',
  'Cirmak Haustechnik GmbH',
  'Industriestraße 18',
  '32105 Bad Salzuflen',
  'Erinnerung Umsatzsteuer-Voranmeldung',
  'Datum 01.03.2026 · Az. 305/5803/1234-USt',
].join('\n');

const BG_BAU_TEXT = [
  'B BG BAU Bezirksverwaltung OWL',
  'Behördenschreiben',
  'Bielefeld',
  'Cirmak Haustechnik GmbH',
  'Industriestraße 18',
  '32105 Bad Salzuflen',
  'Beitragsbescheid',
  'Datum 15.02.2026 · Az. BG-OWL-88421',
].join('\n');

afterEach(() => {
  setOcrOnlyRecognizedDataEnabledForTests(null);
});

function recognizedDataFor(kind: string, recognizedText: string): Record<string, string> {
  setOcrOnlyRecognizedDataEnabledForTests(true);
  return buildEvidenceBasedRecognizedData({
    classifiedKind: kind as never,
    recognizedText,
  });
}

function profileSenderFor(recognizedText: string): string | undefined {
  const pipeline = runReceiptAnalysisPipeline({ recognizedText });
  return buildDocumentProfile({ pipeline, recognizedText }).senderEntity;
}

describe('LETTERHEAD-INITIALS-01 — Initiale wird in allen drei Pfaden entfernt', () => {
  it('Tankstellenpfad entfernt die Initiale vor dem Stationsnamen', () => {
    const data = recognizedDataFor('tankbeleg', TANKBELEG_TEXT);
    expect(data.Tankstelle).toBe('Aral Station Nord');
    expect(data.Tankstelle).not.toMatch(/^A\s/);
  });

  it('Behörden-Absender entfernt die Initiale vor dem Behördennamen', () => {
    const data = recognizedDataFor('finanzamt', FINANZAMT_TEXT);
    expect(data.Absender).toBe('Finanzamt Detmold');
    expect(data.Absender).not.toMatch(/^F\s/);
  });

  it('Profile-Sender entfernt die Initiale vor dem Behördennamen', () => {
    expect(profileSenderFor(BG_BAU_TEXT)).toBe('BG BAU Bezirksverwaltung OWL');
  });

  it('Absender und Lieferant widersprechen sich nicht mehr wegen der Initiale', () => {
    const data = recognizedDataFor('finanzamt', FINANZAMT_TEXT);
    expect(data.Absender).toBeTruthy();
    expect(data.Lieferant).toBeTruthy();
    expect(data.Absender).toBe(data.Lieferant);
  });
});

describe('LETTERHEAD-INITIALS-01 — Gegenbeispiele bleiben unverändert', () => {
  const UNCHANGED = [
    'AOK NordWest',
    'BG BAU Bezirksverwaltung OWL',
    'SOKA-BAU',
    'Praxis Dr. Vogt',
    'Sägewerk Ernst Flisch GmbH',
  ];

  for (const name of UNCHANGED) {
    it(`bleibt unverändert: ${name}`, () => {
      expect(cleanLetterheadCandidate(name)).toBe(name);
    });
  }

  it('entfernt ausschließlich eine alleinstehende Initiale', () => {
    expect(cleanLetterheadCandidate('A Aral Station Nord')).toBe('Aral Station Nord');
    expect(cleanLetterheadCandidate('B BG BAU Bezirksverwaltung OWL')).toBe(
      'BG BAU Bezirksverwaltung OWL',
    );
  });
});

describe('LETTERHEAD-INITIALS-01 — kein Überschreiben mit unsicherem Wert', () => {
  it('ein unsicherer Kandidat ersetzt keinen bereits sauberen Absender', () => {
    // Die Behörden-Kopfzeile besteht nur aus einer Straßenangabe: cleanLetterheadCandidate
    // liefert dafür keinen sicheren Wert. Der zuvor aus den extrahierten Feldern
    // gesetzte Absender muss erhalten bleiben — weder undefined noch Rohtext.
    const text = [
      'Büchenstraße 6',
      'Behördenschreiben',
      'Absender: Finanzamt Detmold',
      'Erinnerung Umsatzsteuer-Voranmeldung',
      'Datum 01.03.2026 · Az. 305/5803/1234-USt',
    ].join('\n');

    const data = recognizedDataFor('finanzamt', text);
    expect(data.Absender).toBeTruthy();
    expect(data.Absender).not.toBe('Büchenstraße 6');
    expect(data.Absender).toContain('Finanzamt Detmold');
  });
});
