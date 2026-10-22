/**
 * DOKUMENTE-01 / F8 — „ust" ist nur als eigenes Wort die Umsatzsteuer.
 *
 * Die Betragsregel erkannte die Umsatzsteuer an „ust" irgendwo im Wort. Damit
 * wurde ein Betrag neben „August", „Austausch" oder „Musterstraße" zur Steuer —
 * ohne Forderung an uns, also ohne Buchungsvorschlag. „USt." und „MwSt" als
 * eigene Wörter sowie „Umsatzsteuer"/„Mehrwertsteuer" (auch in Zusammensetzungen)
 * bleiben Steuer.
 *
 * Alle Texte sind frei erfunden.
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentSemanticCore } from './documentSemanticCoreService';

const rolle = (text: string, wert: number) =>
  buildDocumentSemanticCore({ text, companyProfile: null }).amounts.find((b) => b.value === wert)?.role;

describe('DOKUMENTE-01 F8 — Umsatzsteuer nur als eigenes Wort', () => {
  it('„August" macht einen Betrag nicht zur Steuer', () => {
    expect(rolle('Abschlag für Arbeiten im August 2026: 1.200,00 EUR', 1200)).not.toBe('tax_amount');
  });

  it('„Austausch" macht einen Betrag nicht zur Steuer', () => {
    expect(rolle('Austausch der Heizungspumpe 380,00 EUR', 380)).not.toBe('tax_amount');
  });

  it('„Musterstraße" in derselben Zeile macht einen Betrag nicht zur Steuer', () => {
    expect(rolle('Lieferadresse Musterstraße 4 – Material 95,50 EUR', 95.5)).not.toBe('tax_amount');
  });

  it('eine Forderung neben „August" bleibt eine Forderung', () => {
    const core = buildDocumentSemanticCore({
      text: 'Zahlungserinnerung\nDer Rechnungsbetrag aus August von 1.200,00 EUR ist noch offen.',
      companyProfile: null,
    });
    const betrag = core.amounts.find((b) => b.value === 1200);
    expect(betrag?.role).not.toBe('tax_amount');
    expect(betrag?.isClaimAgainstUs).toBe(true);
  });

  it.each([
    ['zzgl. 19 % USt. 72,20 EUR', 72.2],
    ['MwSt 19 %: 57,00 €', 57],
    ['enthaltene Umsatzsteuer 38,00 EUR', 38],
    ['Mehrwertsteuer 19 % 190,00 EUR', 190],
    ['Umsatzsteuerbetrag 45,60 EUR', 45.6],
  ])('„%s" bleibt Steuer', (text, wert) => {
    expect(rolle(text, wert)).toBe('tax_amount');
  });
});
