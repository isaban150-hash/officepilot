/**
 * EINRICHTUNG-01 (AP6; Verträge 1.18, 1.19, 1.21, 1.22) — Prüfregeln des Firmenprofils als reine Funktionen.
 *
 *   F-02.1–F-02.8  Formatregeln (USt-IdNr., PLZ, BIC, Ländercode, Telefon, Website, E-Mail) und gültige Grenzwerte
 *   F-03.1/F-03.2  IBAN: eine elektronische Normalform (Einstellungen und Assistent), Anzeige in Vierergruppen
 *   F-05.1/F-05.2  Rechtsform-Regel des Absendernamens — gleiche Testvektoren für Client und Server
 *   E-04.1         Anzeigename: Grenzen und verbotene Zeichen (Client und Server gleich)
 *   V-01.2         Angebotsgültigkeit 1–365, Text wie „abc“ abgewiesen
 *   V-02.1/V-04.1  genau ein Standardhinweis „steuerfrei“; „unklar“ verweist auf „Rechnungen und Zahlungen“
 *   V-03.1a–c      Fußzeile und Hinweis „steuerfrei“: 2000 Codepunkte (gemischt aus „ä“, „€“ und Emoji)
 *   E-02.1a–c/E-02.2  Betreffe (Rechnung, Angebot, Brief): 255 Codepunkte, kein Zeilenumbruch
 *
 * Neutrale Beispieldaten, kein Netz.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkCompanyProfileFormats,
  formatIbanGroups,
  isPlausibleCompanyPhone,
  isPlausibleWebsite,
  isPlausibleZip,
  normalizeBicInput,
  normalizeCompanyProfileFormats,
  normalizeIbanInput,
} from './companyProfileFormatRules';
import {
  composeSenderLegalName as composeClient,
  senderDisplayNameProblem as problemClient,
  SENDER_DISPLAY_NAME_MAX_CODE_POINTS,
} from './senderDisplayName';
import {
  composeSenderLegalName as composeServer,
  senderDisplayNameProblem as problemServer,
} from '../../../supabase/functions/_shared/senderDisplayName';
import {
  findCompanyProfileTextLimitViolations,
  isOfferValidityDays,
  resolveProfileSenderDisplayName,
  validateCompanyProfileOptionalFields,
} from './companyProfileSettingsContract';
import { validateCompanyProfileForSettings } from '../setupValidationService';
import { parseOfferValidityDays } from '../../pages/settings/OfferSettingsPage';
import { buildLegalNotices as buildFromTaxService, normalizeLegalNoticesForTaxStatus, UNCLEAR_TAX_NOTICE } from '../invoiceTaxService';
import { buildLegalNotices as buildFromInvoiceService } from '../invoiceService';
import { LEGACY_TAX_FREE_NOTICES, STANDARD_TAX_FREE_NOTICE } from '../invoice/taxNoticeTexts';
import { completeSetupWizard } from '../setupCompletionService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import { resetInvoiceNumberSequence } from '../invoiceNumberService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createDefaultSetupWizardDraft } from '../../types/setup';
import type { CompanyProfile } from '../../types/models';

const VALID: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Haustechnik GmbH',
  contactPerson: 'Erika Beispiel',
  street: 'Musterstraße 5',
  zip: '33602',
  city: 'Bielefeld',
  email: 'info@muster-haustechnik.invalid',
  taxNumber: '133/8150/8159',
  iban: 'DE89370400440532013000',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
};

/** Genau `count` Codepunkte, abwechselnd „ä“, „€“ und ein Emoji (zwei UTF-16-Einheiten). */
function mixed(count: number): string {
  const parts = ['ä', '€', String.fromCodePoint(0x1f600)];
  return Array.from({ length: count }, (_, index) => parts[index % parts.length]).join('');
}

describe('F-02 Formatregeln (Firmendaten, streng)', () => {
  it('F-02.1–F-02.7: jede Regel weist ab und sperrt das Speichern', () => {
    const cases: Array<[keyof CompanyProfile, string]> = [
      ['vatId', 'DE12345678'],
      ['zip', '3360'],
      ['bic', 'DEUTDEF'],
      ['countryCode', 'XX'],
      ['phone', '12345'],
      ['website', 'javascript:alert(1)'],
      ['email', 'info@'],
    ];
    for (const [field, value] of cases) {
      const result = validateCompanyProfileForSettings({ ...VALID, [field]: value } as CompanyProfile, 0, { formatChecks: 'strict' });
      expect(result.valid, `${String(field)}=${value}`).toBe(false);
      expect(result.errors[field as string], String(field)).toBeTruthy();
    }
  });

  it('F-02.6: andere Schemata als http(s) werden nie als Website angenommen', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,abc', 'ftp://beispiel.de', 'mailto:info@beispiel.de', 'http://', 'beispiel']) {
      expect(isPlausibleWebsite(value), value).toBe(false);
    }
  });

  it('F-02.8: gültige Grenzwerte je Regel werden angenommen', () => {
    expect(checkCompanyProfileFormats({ vatId: 'DE123456789' })).toEqual({});
    expect(isPlausibleZip('12345', 'DE')).toBe(true);
    expect(isPlausibleZip('1010', 'AT')).toBe(true);
    expect(isPlausibleZip('8001', 'CH')).toBe(true);
    expect(isPlausibleZip('AB', null)).toBe(true);
    expect(isPlausibleZip('SW1A 1AA', null)).toBe(true);
    expect(isPlausibleZip('A'.repeat(11), null)).toBe(false);
    expect(checkCompanyProfileFormats({ zip: '1010', countryCode: 'AT' })).toEqual({});
    expect(checkCompanyProfileFormats({ bic: 'DEUTDEFF' })).toEqual({});
    expect(checkCompanyProfileFormats({ bic: 'deutdeff500' })).toEqual({});
    expect(normalizeBicInput(' deut deff ')).toBe('DEUTDEFF');
    expect(checkCompanyProfileFormats({ countryCode: 'ch' })).toEqual({});
    expect(isPlausibleCompanyPhone('123456')).toBe(true);
    expect(isPlausibleCompanyPhone(`+49 (0) 521/12-${'3'.repeat(15)}`.slice(0, 30))).toBe(true);
    expect(isPlausibleCompanyPhone('1'.repeat(31))).toBe(false);
    expect(isPlausibleWebsite('beispiel.de')).toBe(true);
    expect(isPlausibleWebsite('https://www.beispiel.de/pfad?x=1')).toBe(true);
    expect(validateCompanyProfileForSettings({ ...VALID, vatId: 'de 123 456 789', website: 'www.beispiel.de' }, 0, { formatChecks: 'strict' }).valid).toBe(true);
  });

  it('andere Einstellungsseiten (ohne strenge Prüfung) blockiert ein älterer Wert nicht', () => {
    expect(validateCompanyProfileForSettings({ ...VALID, website: 'javascript:alert(1)' }, 0).valid).toBe(true);
  });

  it('Speicherform: BIC und USt-IdNr. groß, Ländercode normalisiert', () => {
    expect(normalizeCompanyProfileFormats({ bic: 'deutdeff', vatId: 'de123456789', countryCode: 'at' })).toEqual({
      bic: 'DEUTDEFF',
      vatId: 'DE123456789',
      countryCode: 'AT',
    });
  });
});

describe('F-03 IBAN', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
    resetInvoiceNumberSequence();
  });

  it('F-03.1: Speicherform ohne Leerzeichen in Großbuchstaben, Anzeige in Vierergruppen', () => {
    expect(normalizeIbanInput('de89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
    expect(formatIbanGroups('DE89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
    expect(normalizeCompanyProfileFormats({ iban: 'de89 3704 0044 0532 0130 00' }).iban).toBe('DE89370400440532013000');
  });

  it('F-03.2: der Assistent speichert dieselbe Normalform', () => {
    const draft = createDefaultSetupWizardDraft(DEFAULT_SETUP, { ...VALID, iban: '' }, 0);
    draft.iban = 'de89 3704 0044 0532 0130 00';
    const result = completeSetupWizard(draft, DEFAULT_SETUP);
    expect(result.success).toBe(true);
    expect(getCompanyProfile().iban).toBe(normalizeIbanInput('de89 3704 0044 0532 0130 00'));
  });
});

describe('F-05 Rechtsform und Absendername — Client = Server', () => {
  const VECTORS: Array<[string, string, string]> = [
    ['Muster', '', 'Muster'],
    ['Muster GmbH', 'GmbH', 'Muster GmbH'],
    ['Muster Gmbh.', 'GmbH', 'Muster Gmbh.'],
    ['Muster GmbH & Co. KG', 'GmbH & Co. KG', 'Muster GmbH & Co. KG'],
    ['Muster', 'GmbH', 'Muster GmbH'],
    ['  Muster   Bau  ', 'GmbH', 'Muster Bau GmbH'],
    ['Muster GmbH,', 'GmbH', 'Muster GmbH,'],
    ['Muster e.K.', 'e.K.', 'Muster e.K.'],
    ['Muster gmbh', ' GmbH ', 'Muster gmbh'],
    // Festlegung (A6-12): Die Rechtsform zählt nur als ganzes Wort am Ende.
    ['Bauag', 'AG', 'Bauag AG'],
  ];

  it('F-05.2: dieselben Ergebnisse in Client- und Serverregel', () => {
    for (const [name, legalForm, expected] of VECTORS) {
      expect(composeClient(name, legalForm), `${name} + ${legalForm}`).toBe(expected);
      expect(composeServer(name, legalForm), `${name} + ${legalForm} (Server)`).toBe(expected);
    }
  });

  it('F-05.1: „Muster GmbH“ mit Rechtsform „GmbH“ ohne Anzeigename → „Muster GmbH“', () => {
    expect(resolveProfileSenderDisplayName({ ...VALID, companyName: 'Muster GmbH', legalForm: 'GmbH', senderDisplayName: '' })).toBe('Muster GmbH');
  });
});

describe('E-04 Anzeigename', () => {
  it('E-04.1: Grenzen und verbotene Zeichen — Client und Server gleich', () => {
    const cases: Array<[string, ReturnType<typeof problemClient>]> = [
      ['Muster <b>', 'forbidden_character'],
      ['Muster @ Bau', 'forbidden_character'],
      ['info@muster.de', 'forbidden_character'],
      ['Muster "Bau"', 'forbidden_character'],
      ['Zeile\nZwei', 'line_break'],
      [`Zeile${String.fromCharCode(0x2028)}Zwei`, 'line_break'],
      [mixed(SENDER_DISPLAY_NAME_MAX_CODE_POINTS + 1), 'too_long'],
      [mixed(SENDER_DISPLAY_NAME_MAX_CODE_POINTS), null],
      ['  Muster Bau  ', null],
    ];
    for (const [value, expected] of cases) {
      expect(problemClient(value), JSON.stringify(value)).toBe(expected);
      expect(problemServer(value), `${JSON.stringify(value)} (Server)`).toBe(expected);
    }
    expect(validateCompanyProfileOptionalFields({ senderDisplayName: 'info@muster.de' })).toBe('companyProfile.senderDisplayNameInvalid');
    expect(validateCompanyProfileOptionalFields({ senderDisplayName: 'Muster Bau' })).toBeNull();
  });
});

describe('V-01.2 Angebotsgültigkeit', () => {
  it('ganze Tage 1–365; 0, 366, „abc“ und Dezimalzahlen abgewiesen', () => {
    for (const ok of [1, 30, 365]) expect(isOfferValidityDays(ok), String(ok)).toBe(true);
    for (const bad of [0, 366, 14.5, -1, '14', Number.NaN]) expect(isOfferValidityDays(bad), String(bad)).toBe(false);
    expect(parseOfferValidityDays('14')).toEqual({ ok: true, value: 14 });
    expect(parseOfferValidityDays('')).toEqual({ ok: true, value: undefined });
    for (const text of ['0', '366', 'abc', '1,5', '14 Tage', '-3']) expect(parseOfferValidityDays(text), text).toEqual({ ok: false });
    expect(validateCompanyProfileOptionalFields({ offerValidityDays: 366 })).toBe('companyProfile.offerValidityDaysInvalid');
  });
});

describe('V-02 / V-04 Steuerhinweise', () => {
  it('V-02.1: genau ein Standardtext; Rechnung und Angebot nutzen dieselbe Quelle; eigener Text geht vor', () => {
    expect(buildFromInvoiceService).toBe(buildFromTaxService);
    expect(buildFromTaxService('tax_free', { taxFreeNotice: '' })).toEqual([STANDARD_TAX_FREE_NOTICE]);
    expect(buildFromTaxService('tax_free')).toEqual([STANDARD_TAX_FREE_NOTICE]);
    expect(DEFAULT_COMPANY_PROFILE.taxFreeNotice).toBe(STANDARD_TAX_FREE_NOTICE);
    expect(buildFromTaxService('tax_free', { taxFreeNotice: 'Steuerfrei nach § 4 Nr. 11 UStG.' })).toEqual(['Steuerfrei nach § 4 Nr. 11 UStG.']);
  });

  it('V-02.1: die frühere Standardfassung zählt weiter als Standardhinweis (keine Doppelung)', () => {
    const normalized = normalizeLegalNoticesForTaxStatus('tax_free', [...LEGACY_TAX_FREE_NOTICES], { taxFreeNotice: '' });
    expect(normalized).toEqual([STANDARD_TAX_FREE_NOTICE]);
  });

  it('V-04.1: „unklar“ verweist auf „Rechnungen und Zahlungen“', () => {
    expect(buildFromTaxService('unclear')).toEqual([UNCLEAR_TAX_NOTICE]);
    expect(UNCLEAR_TAX_NOTICE).toContain('Dokumente und Zahlungen › Rechnungen und Zahlungen');
  });
});

describe('V-03.1 / E-02 Textgrenzen in Codepunkten', () => {
  const violations = (patch: Record<string, unknown>) => findCompanyProfileTextLimitViolations(patch).map((v) => v.field);

  it('V-03.1a–c: Fußzeile und Hinweis „steuerfrei“ — 1999 und 2000 angenommen, 2001 abgewiesen', () => {
    for (const field of ['invoiceFooterNotes', 'taxFreeNotice']) {
      expect(violations({ [field]: mixed(1999) }), `${field} 1999`).toEqual([]);
      expect(violations({ [field]: mixed(2000) }), `${field} 2000`).toEqual([]);
      expect(violations({ [field]: mixed(2001) }), `${field} 2001`).toEqual([field]);
      expect(validateCompanyProfileForSettings({ ...VALID, [field]: mixed(2001) } as CompanyProfile, 0).errors[field]).toBeTruthy();
    }
  });

  it('Vorlagen für Angebote, Aufträge und Briefe: 2000 Codepunkte', () => {
    for (const field of ['offerIntroText', 'offerClosingText', 'orderIntroText', 'orderClosingText', 'letterSalutation', 'letterClosing']) {
      expect(violations({ [field]: mixed(2000) }), field).toEqual([]);
      expect(violations({ [field]: mixed(2001) }), field).toEqual([field]);
    }
  });

  it('E-02.1a–c / E-02.2: Betreffe — 254 und 255 angenommen, 256 und Zeilenumbruch abgewiesen', () => {
    for (const field of ['defaultInvoiceEmailSubject', 'defaultOfferEmailSubject', 'defaultLetterEmailSubject']) {
      expect(violations({ [field]: mixed(254) }), `${field} 254`).toEqual([]);
      expect(violations({ [field]: mixed(255) }), `${field} 255`).toEqual([]);
      expect(violations({ [field]: mixed(256) }), `${field} 256`).toEqual([field]);
      expect(violations({ [field]: 'Rechnung\n2026-0001' }), `${field} Zeilenumbruch`).toEqual([field]);
    }
  });
});
