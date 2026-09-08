/**
 * INVOICE-SKONTO-PAYMENT-TERMS-CONSISTENCY-01B
 *
 * Auf einer echten Rechnung standen nebeneinander:
 *
 *   „Zahlbar innerhalb von 14 Tagen ohne Abzug."
 *   „Bei Zahlung innerhalb von 10 Tagen gewähren wir 7 % Skonto."
 *
 * Der erste Satz verneint wörtlich, was der zweite gewährt. Ursache waren zwei
 * Textbauer, die nichts voneinander wussten: `buildDefaultPaymentTerms` kannte
 * die Skontofelder nicht, `buildSkontoText` hängte seinen Satz daneben.
 *
 * Geprüft wird die **Erzeugung** — nicht das Rendern. PDF, Druck und Vorschau
 * speisen sich aus denselben gespeicherten Feldern und profitieren automatisch.
 *
 * Zwei Dinge müssen dabei unangetastet bleiben:
 *   1. Ein individuell formulierter Zahlungstext. Er gehört dem Betrieb.
 *   2. Der Wortlaut des Skontosatzes — `financeIntelligenceService` liest
 *      Prozent und Frist per Regex daraus zurück.
 */
import { describe, expect, it } from 'vitest';
import type { CompanyProfile, Vorgang } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { buildInvoiceDraftForType } from '../invoiceService';
import { buildSkontoText } from '../invoiceTaxService';
import { buildInvoicePrintModel } from '../invoicePrintModel';

const VORGANG_ID = 'v-test-1';

const STANDARD_WITH_DEDUCTION = 'Zahlbar innerhalb von 14 Tagen ohne Abzug.';
const STANDARD_PLAIN = 'Zahlbar innerhalb von 14 Tagen.';
const SKONTO_SENTENCE = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 7 % Skonto.';

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Beispielstadt',
    iban: 'DE00 0000 0000 0000 0000 00',
    defaultPaymentDays: 14,
    defaultPaymentTerms: STANDARD_WITH_DEDUCTION,
    ...overrides,
  };
}

/** Der Realfall: 14 Tage Zahlungsziel, 7 % Skonto, 10 Tage Frist. */
function withSkonto(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return profile({
    skontoEnabled: true,
    skontoPercent: 7,
    skontoDays: 10,
    ...overrides,
  });
}

function seed(companyProfile: CompanyProfile): Vorgang {
  hydrateCompanyProfileStore(companyProfile);
  const vorgang = createTestVorgang({ id: VORGANG_ID });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

function draftFor(
  companyProfile: CompanyProfile,
  type: Parameters<typeof buildInvoiceDraftForType>[2] = 'rechnung',
) {
  seed(companyProfile);
  const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, type);
  if (!draft) throw new Error('draft_missing');
  return draft;
}

describe('SKONTO-TERMS-01B — der Basissatz kennt jetzt das Skonto', () => {
  it('K1: ohne Skonto bleibt „ohne Abzug" stehen', () => {
    const draft = draftFor(profile({ skontoEnabled: false }));
    expect(draft.paymentTermsText).toBe(STANDARD_WITH_DEDUCTION);
    expect(draft.skontoText).toBe('');
  });

  it('K1b: auch ohne gesetzten Schalter bleibt der bisherige Satz', () => {
    // Altbestand: `skontoEnabled` ist undefined, kein Skonto abgeleitet.
    const draft = draftFor(profile({ skontoEnabled: undefined, defaultSkonto: '' }));
    expect(draft.paymentTermsText).toBe(STANDARD_WITH_DEDUCTION);
  });

  it('K2: mit gültigem Skonto verschwindet der Widerspruch', () => {
    const draft = draftFor(withSkonto());
    expect(draft.paymentTermsText).toBe(STANDARD_PLAIN);
    expect(draft.paymentTermsText).not.toContain('ohne Abzug');
  });

  it('K3: der Skontosatz bleibt unverändert daneben stehen', () => {
    const draft = draftFor(withSkonto());
    expect(draft.skontoText).toBe(SKONTO_SENTENCE);
    // Der Wortlaut ist Vertrag — siehe K5.
    expect(buildSkontoText(withSkonto())).toBe(SKONTO_SENTENCE);
  });

  it('K2b: ein unvollständiges Skonto ändert den Basissatz nicht', () => {
    /*
     * Prozent ohne Frist oder Frist ohne Prozent ergibt keinen Skontosatz —
     * dann darf auch der Basissatz nicht angefasst werden, sonst verspräche
     * die Rechnung stillschweigend einen Abzug, den es nicht gibt.
     */
    for (const broken of [
      withSkonto({ skontoPercent: 0 }),
      withSkonto({ skontoDays: 0 }),
      withSkonto({ skontoPercent: undefined }),
      withSkonto({ skontoDays: undefined }),
    ]) {
      const draft = draftFor(broken);
      expect(draft.skontoText, JSON.stringify(broken.skontoPercent)).toBe('');
      expect(draft.paymentTermsText).toBe(STANDARD_WITH_DEDUCTION);
    }
  });
});

describe('SKONTO-TERMS-01B — individuelle Texte bleiben unangetastet', () => {
  const OWN = 'Zahlbar sofort nach Rechnungserhalt gemäß Vereinbarung.';

  it('K4: ein eigener Zahlungstext wird wortgleich übernommen', () => {
    const draft = draftFor(withSkonto({ defaultPaymentTerms: OWN }));
    expect(draft.paymentTermsText).toBe(OWN);
  });

  it('K4b: auch ein eigener Text mit „ohne Abzug" wird nicht umgeschrieben', () => {
    /*
     * Kein Herumschneiden an fremder Prosa: Wer selbst formuliert hat, hat
     * Gründe. Angepasst wird ausschliesslich der von OfficePilot erzeugte
     * Standardsatz.
     */
    const own = 'Zahlbar in 30 Tagen ohne Abzug, sofern nichts anderes vereinbart ist.';
    const draft = draftFor(withSkonto({ defaultPaymentTerms: own }));
    expect(draft.paymentTermsText).toBe(own);
    expect(draft.paymentTermsText).toContain('ohne Abzug');
  });

  it('K4c: der Standard wird auch bei abweichendem Zahlungsziel erkannt', () => {
    const draft = draftFor(
      withSkonto({
        defaultPaymentDays: 30,
        defaultPaymentTerms: 'Zahlbar innerhalb von 30 Tagen ohne Abzug.',
      }),
    );
    expect(draft.paymentTermsText).toBe('Zahlbar innerhalb von 30 Tagen.');
  });

  it('K4d: ein leerer Zahlungstext fällt auf den Standard zurück', () => {
    expect(draftFor(profile({ defaultPaymentTerms: '' })).paymentTermsText).toBe(
      STANDARD_WITH_DEDUCTION,
    );
    expect(draftFor(withSkonto({ defaultPaymentTerms: '' })).paymentTermsText).toBe(
      STANDARD_PLAIN,
    );
  });
});

describe('SKONTO-TERMS-01B — nichts anderes verändert sich', () => {
  it('K5: der Skontosatz bleibt für financeIntelligence lesbar', () => {
    /*
     * Weil Prozent und Frist auf der Rechnung nicht strukturiert vorliegen,
     * liest `financeIntelligenceService` sie per Regex aus dem Satz zurück.
     * Ein geänderter Wortlaut wäre eine stille Regression — dieser Test hält
     * die Kopplung fest, bis das Modell die Werte selbst trägt.
     */
    const sentence = draftFor(withSkonto()).skontoText;

    /*
     * Die beiden Muster stammen wörtlich aus `parseSkontoFromText`
     * (financeIntelligenceService.ts:136 und :145). Sie sind hier gespiegelt,
     * weil die Funktion nicht exportiert ist — und weil genau diese Kopplung
     * sichtbar bleiben soll: Solange Prozent und Frist nicht strukturiert auf
     * der Rechnung stehen, hängt eine Auswertung am Wortlaut.
     */
    const percentFirst = sentence.match(/(\d+(?:[.,]\d+)?)\s*%.*?(\d+)\s*tage/i);
    const daysFirst = sentence.match(/(\d+)\s*tage.*?(\d+(?:[.,]\d+)?)\s*%/i);
    const parsed = percentFirst
      ? { percent: Number(percentFirst[1].replace(',', '.')), days: Number(percentFirst[2]) }
      : daysFirst
        ? { percent: Number(daysFirst[2].replace(',', '.')), days: Number(daysFirst[1]) }
        : null;

    expect(parsed, 'Der Skontosatz ist nicht mehr maschinell lesbar').not.toBeNull();
    expect(parsed).toEqual({ percent: 7, days: 10 });
  });

  it('K12/K19: das Fälligkeitsdatum folgt weiterhin dem Zahlungsziel', () => {
    const withoutSkonto = draftFor(profile({ skontoEnabled: false }));
    const withSkontoDraft = draftFor(withSkonto());
    // Skonto (10 Tage) darf die Fälligkeit (14 Tage) nicht verkürzen.
    expect(withSkontoDraft.paymentDueDate).toBe(withoutSkonto.paymentDueDate);
  });

  it('K10: alle Rechnungstypen verhalten sich gleich', () => {
    for (const type of ['rechnung', 'abschlag', 'teilrechnung', 'schluss'] as const) {
      const draft = draftFor(withSkonto(), type);
      expect(draft.paymentTermsText, type).toBe(STANDARD_PLAIN);
      expect(draft.skontoText, type).toBe(SKONTO_SENTENCE);
    }
  });

  it('K7/K8: das Druckmodell trägt beide Angaben widerspruchsfrei', () => {
    /*
     * Die Lücke aus der Analyse: Alle bestehenden Fixtures hatten
     * `skontoText: ''`. Hier stehen beide Felder erstmals gemeinsam.
     */
    const draft = draftFor(withSkonto());
    const model = buildInvoicePrintModel(draft, DEFAULT_SETUP);

    expect(model.paymentTermsText).toBe(STANDARD_PLAIN);
    expect(model.skontoText).toBe(SKONTO_SENTENCE);
    expect(model.paymentTermsText).not.toContain('ohne Abzug');
    expect(model.paymentDueDate).toBe(draft.paymentDueDate);
  });
});
