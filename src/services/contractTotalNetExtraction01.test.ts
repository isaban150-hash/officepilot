import { describe, expect, it } from 'vitest';
import { resolveContractTotalNet } from './documentAmountExtractionService';
import { extractContractTotalAmountFromText } from './contractIntelligenceExtraction';

/**
 * CONTRACT-TOTAL-NET-EXTRACTION-01B — die Auftragssumme darf kein
 * Positionsbetrag sein.
 *
 * Gemessener Fehler: Ein Werkvertrag mit Positionstabelle wies 12,50 € als
 * Vertragssumme aus — den Einzelpreis der ersten Position. Zustande kam das
 * durch zwei Schwächen, die hier beide abgesichert werden: die fehlende
 * Beschriftung `Nettosumme` und ein Rückfall, der die Spaltenüberschrift
 * `Gesamtpreis` über Zeilengrenzen hinweg mit dem nächstbesten Betrag verband.
 */

/** Ein Beleg, wie ihn ein Handwerksbetrieb schreibt: Tabelle plus Summenblock. */
const VERTRAG_MIT_TABELLE = [
  'Werkvertrag',
  'Vertragsnummer WV-2026-0036 · Vertragsdatum 09.02.2026',
  'Pos. Menge Einheit Leistung Einzelpreis Gesamtpreis',
  '01 96 m² Altbelag aufnehmen und Untergrund vorbereiten 12,50 € 1.200,00 €',
  '02 148 m Rohrleitung verlegen und dämmen 34,80 € 5.150,40 €',
  '03 42 Std Demontage und Entsorgung 68,00 € 2.856,00 €',
  'Nettosumme 9.206,40 €',
  'zzgl. 19 % USt. 1.749,22 €',
  'Auftragssumme brutto 10.955,62 €',
].join('\n');

/** Derselbe Beleg ohne ausgewiesene Summe — nur Tabelle. */
const VERTRAG_OHNE_SUMME = [
  'Werkvertrag',
  'Pos. Menge Einheit Leistung Einzelpreis Gesamtpreis',
  '01 96 m² Altbelag aufnehmen und Untergrund vorbereiten 12,50 € 1.200,00 €',
  '02 148 m Rohrleitung verlegen und dämmen 34,80 € 5.150,40 €',
].join('\n');

describe('Vertragssumme aus Belegtext', () => {
  it('liest die ausgewiesene Nettosumme statt eines Positionsbetrags', () => {
    const feld = resolveContractTotalNet(VERTRAG_MIT_TABELLE);

    expect(feld.status).toBe('confirmed');
    expect(feld.value).toBe(9206.4);
    /* Der Einzelpreis der ersten Position darf nie das Ergebnis sein. */
    expect(feld.value).not.toBe(12.5);
  });

  it('Rückfall: die ausgewiesene Nettosumme wird ebenfalls gefunden', () => {
    const feld = extractContractTotalAmountFromText(VERTRAG_MIT_TABELLE);

    expect(feld?.value).toBe(9206.4);
    expect(feld?.value).not.toBe(12.5);
  });

  it('Rückfall: eine blosse Spaltenüberschrift erzeugt keine Vertragssumme', () => {
    /*
     * Der Kern des Fehlers. Ohne ausgewiesene Summe darf `Gesamtpreis` als
     * Tabellenkopf nicht dazu führen, dass der erste Positionsbetrag als
     * hochsichere Vertragssumme gilt. Kein Ergebnis ist hier richtig — der
     * Aufrufer greift dann auf die Summe der bestätigten Positionen zurück.
     */
    const feld = extractContractTotalAmountFromText(VERTRAG_OHNE_SUMME);

    expect(feld?.value).not.toBe(12.5);
    expect(feld?.value).not.toBe(1200);
    expect(feld).toBeNull();
  });

  it('ohne ausgewiesene Summe meldet der Resolver keinen Kandidaten', () => {
    const feld = resolveContractTotalNet(VERTRAG_OHNE_SUMME);

    expect(feld.status).not.toBe('confirmed');
    expect(feld.value).toBeUndefined();
  });

  it('bestehende Beschriftungen funktionieren unverändert', () => {
    for (const zeile of [
      'Gesamtsumme netto 9.206,40 €',
      'Vertragssumme 9.206,40 €',
      'Auftragssumme netto 9.206,40 €',
    ]) {
      const feld = resolveContractTotalNet(`Werkvertrag\n${zeile}`);
      expect(feld.value, zeile).toBe(9206.4);
    }
  });
});
