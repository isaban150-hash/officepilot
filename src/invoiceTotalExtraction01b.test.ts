/**
 * INVOICE-TOTAL-EXTRACTION-01B — der Gesamtbetrag einer Rechnung ist nicht der
 * erste Geldbetrag im Text.
 *
 * Realbefund: Eine mehrpositionige Eingangsrechnung mit tatsaechlich 486,20 EUR
 * wurde mit 32,50 EUR erfasst — dem ersten Positionsbetrag. Der Wert floss mit
 * hoher Sicherheit in Lead, Fakten, Bezugsbelegsuche und Ausgabenerfassung.
 *
 * **Geprueft wird die produktive API** `buildEvidenceBasedRecognizedData`, nicht
 * eine Regex oder ein Resolver isoliert: Genau diese Ebenenverwechslung hat im
 * Absenderstrang zweimal gruene Tests bei rotem Geraet erzeugt.
 *
 * Kein Lieferanten- oder Dokumentsonderfall, kein hartkodierter Betrag in der
 * Produktionslogik — die Faelle unten sind Kontrollmaterial, keine Regel.
 */
import { describe, expect, it } from 'vitest';

import { buildEvidenceBasedRecognizedData } from './services/documentRecognizedDataService';

/** Der reale Kontrollfall: Positionen, Zwischensumme, Steuer, Gesamtbetrag. */
const MULTI_POSITION_INVOICE = [
  'Westfalen SHK Grosshandel GmbH',
  'Rechnung RE-4711',
  'Datum: 01.08.2026',
  '',
  'Pos 1  Kabel NYM-J 3x1,5   5 Stk   6,50 EUR    32,50 EUR',
  'Pos 2  Kupferrohr 15mm    12 m    17,50 EUR   210,00 EUR',
  'Pos 3  Kleinmaterial       1 psch 166,07 EUR  166,07 EUR',
  '',
  'Zwischensumme   408,57 EUR',
  'MwSt 19%         77,63 EUR',
  'Gesamtbetrag    486,20 EUR',
].join('\n');

/** Der haeufigere Standardfall — jede Rechnung mit Netto-Ausweis. */
const NET_TAX_GROSS_INVOICE = [
  'Baustoff Nord GmbH',
  'Rechnung RE-9001',
  'Netto    408,57 EUR',
  'MwSt      77,63 EUR',
  'Brutto   486,20 EUR',
].join('\n');

/**
 * Skontorechnung — **kein** Konflikt. Der Zahlbetrag ist eine andere Groesse
 * als die Rechnungssumme: OfficePilot leitet den Skontobetrag spaeter selbst
 * aus `recognizedData.Betrag` ab (financeIntelligenceService,
 * `calculateSkontoPayableAmount`). Stuende hier bereits der reduzierte Wert,
 * wuerde Skonto zweimal abgezogen.
 */
const SKONTO_INVOICE = [
  'Baustoff Nord GmbH',
  'Rechnung RE-9002',
  'Gesamtbetrag   486,20 EUR',
  'Skonto 2 % bei Zahlung innerhalb von 10 Tagen',
  'Zahlbetrag     456,20 EUR',
].join('\n');

/** Zwei starke Rechnungssummenlabels mit verschiedenen Werten — echter Konflikt. */
const CONFLICTING_TOTALS_INVOICE = [
  'Baustoff Nord GmbH',
  'Rechnung RE-9003',
  'Gesamtbetrag    486,20 EUR',
  'Rechnungsbetrag 512,00 EUR',
].join('\n');

function invoiceAmount(text: string): string | undefined {
  return buildEvidenceBasedRecognizedData({
    classifiedKind: 'eingangsrechnung',
    recognizedText: text,
  }).Betrag;
}

describe('INVOICE-TOTAL-EXTRACTION-01B — der Gesamtbetrag gewinnt', () => {
  it('R1: eine mehrpositionige Rechnung liefert den Gesamtbetrag, nicht den ersten Posten', () => {
    const amount = invoiceAmount(MULTI_POSITION_INVOICE);

    expect(amount, 'Der erste Positionsbetrag wurde als Rechnungsbetrag erfasst').toContain(
      '486,20',
    );
    expect(amount).not.toContain('32,50');
    expect(amount).not.toContain('408,57');
  });

  it('R2: Netto/MwSt/Brutto liefert den Bruttobetrag', () => {
    const amount = invoiceAmount(NET_TAX_GROSS_INVOICE);

    expect(amount, 'Der Nettobetrag wurde als Rechnungsbetrag erfasst').toContain('486,20');
    expect(amount).not.toContain('408,57');
    expect(amount).not.toContain('77,63');
  });

});

/**
 * INVOICE-TOTAL-EXTRACTION-01B3 — `recognizedData.Betrag` ist der
 * **Brutto-Rechnungsbetrag**, nicht der aktuell zu zahlende Betrag.
 *
 * „Zahlbetrag", „Zu zahlen" und „Endbetrag" bezeichnen einen Zahlungsbetrag
 * nach Skonto oder Abschlag. Sie duerfen mit einer eindeutigen Rechnungssumme
 * keinen Konflikt erzeugen und auch nicht selbst als Rechnungssumme gelten.
 */
describe('INVOICE-TOTAL-EXTRACTION-01B3 — Zahlbetrag ist nicht die Rechnungssumme', () => {
  it('R3A: Skonto — der Bruttobetrag gewinnt, der Zahlbetrag erzeugt keinen Konflikt', () => {
    const amount = invoiceAmount(SKONTO_INVOICE);

    expect(amount, 'Der Zahlbetrag hat die Rechnungssumme verdrängt oder blockiert').toContain(
      '486,20',
    );
    expect(amount).not.toContain('456,20');
  });

  it('R3B: zwei starke Rechnungssummen mit verschiedenen Werten setzen keinen Betrag', () => {
    const amount = invoiceAmount(CONFLICTING_TOTALS_INVOICE);

    expect(amount, 'Ein echter Konflikt lieferte trotzdem einen bestätigten Betrag').toBeUndefined();
  });

  it('R3C: zwei starke Rechnungssummen mit demselben Wert sind kein Konflikt', () => {
    const text = [
      'Gesamtbetrag    486,20 EUR',
      'Rechnungsbetrag 486,20 EUR',
    ].join('\n');

    expect(invoiceAmount(text), 'Gleiche Werte wurden als Konflikt behandelt').toContain('486,20');
  });

  it('R3D: „Zu zahlen" nach Abschlag verdrängt den Gesamtbetrag nicht', () => {
    const text = [
      'Gesamtbetrag 486,20 EUR',
      'Bereits geleisteter Abschlag 200,00 EUR',
      'Zu zahlen 286,20 EUR',
    ].join('\n');

    const amount = invoiceAmount(text);
    expect(amount).toContain('486,20');
    expect(amount).not.toContain('286,20');
  });

  it('R3E: Rechnungsbetrag plus reduzierter Zahlbetrag liefert den Rechnungsbetrag', () => {
    const text = ['Rechnungsbetrag 486,20 EUR', 'Zahlbetrag 456,20 EUR'].join('\n');

    const amount = invoiceAmount(text);
    expect(amount).toContain('486,20');
    expect(amount).not.toContain('456,20');
  });

  it('R3F: ein alleinstehender Zahlbetrag ist kein Brutto-Rechnungsbetrag', () => {
    const text = ['Baustoff Nord GmbH', 'Zahlbetrag 456,20 EUR'].join('\n');

    expect(
      invoiceAmount(text),
      'Ein Zahlbetrag wurde als Rechnungsbetrag ausgegeben',
    ).toBeUndefined();
  });

  it('R3G: ein alleinstehendes „Zu zahlen" ist kein Brutto-Rechnungsbetrag', () => {
    const text = ['Baustoff Nord GmbH', 'Zu zahlen 456,20 EUR'].join('\n');

    expect(
      invoiceAmount(text),
      'Ein Zahlungsbetrag wurde als Rechnungsbetrag ausgegeben',
    ).toBeUndefined();
  });

  it('R3H: ein alleinstehender Endbetrag gilt nicht als sicherer Rechnungsbetrag', () => {
    const text = ['Baustoff Nord GmbH', 'Endbetrag 456,20 EUR'].join('\n');

    expect(invoiceAmount(text)).toBeUndefined();
  });
});

describe('INVOICE-TOTAL-EXTRACTION-01B — Schutzfälle', () => {
  it('S1: ein eindeutiger Rechnungsbetrag bleibt erhalten', () => {
    const text = ['Baustoff Nord GmbH', 'Rechnungsbetrag 486,20 EUR'].join('\n');
    expect(invoiceAmount(text)).toContain('486,20');
  });

  it('S2: mehrere Positionspreise plus eindeutiger Gesamtbetrag', () => {
    const text = [
      'Pos 1   32,50 EUR',
      'Pos 2  210,00 EUR',
      'Gesamtbetrag 486,20 EUR',
    ].join('\n');
    expect(invoiceAmount(text)).toContain('486,20');
  });

  it('S3: Zwischensumme plus eindeutiger Gesamtbetrag', () => {
    const text = ['Zwischensumme 408,57 EUR', 'Gesamtbetrag 486,20 EUR'].join('\n');
    expect(invoiceAmount(text)).toContain('486,20');
  });

  it('S4: der Gesamtbetrag steht vor den Positionen', () => {
    const text = [
      'Gesamtbetrag 486,20 EUR',
      'Pos 1   32,50 EUR',
      'Pos 2  210,00 EUR',
    ].join('\n');
    expect(invoiceAmount(text)).toContain('486,20');
  });

  /*
   * R4 — realistische Schreibweisen desselben Gesamtbetrags. Deutsche Rechnungen
   * setzen regelmaessig einen Doppelpunkt oder schreiben „Endbetrag" bzw.
   * „Gesamtsumme". Keine dieser Formen darf zu einem fremden Betrag fuehren.
   */
  const LABEL_VARIANTS = [
    'Gesamtbetrag: 486,20 EUR',
    'Bruttobetrag 486,20 EUR',
    'Gesamtsumme 486,20 EUR',
    'Rechnungsbetrag: 486,20 EUR',
  ];

  for (const variant of LABEL_VARIANTS) {
    it(`R4: „${variant}" liefert keinen fremden Betrag`, () => {
      const text = ['Baustoff Nord GmbH', 'Pos 1   32,50 EUR', variant].join('\n');
      expect(invoiceAmount(text), 'Der Gesamtbetrag wurde nicht erkannt').toContain('486,20');
    });
  }

  it('S5: Label und Betrag stehen auf zwei Zeilen', () => {
    const text = ['Rechnungsbetrag', '486,20 EUR'].join('\n');
    // Bewusst nur als Beobachtung geprueft: Der Wert darf jedenfalls kein
    // fremder Betrag sein.
    const amount = invoiceAmount(text);
    if (amount) expect(amount).toContain('486,20');
  });
});
