import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCriticalCompanyProfileFields,
  buildCriticalCompanyFingerprint,
  findCriticalCompanyProfileDrift,
} from './companySnapshotDriftService';
import { buildInvoiceDraftForType, finalizeInvoiceDraft } from '../invoiceService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgangWithExecutedQuantity, testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { CompanyProfile } from '../../types/models';

/**
 * COMPANY-PROFILE-DRAFT-DRIFT-01E — Firmendaten, die sich nach der
 * Entwurfserstellung ändern.
 *
 * Zwei Aussagen stehen hier nebeneinander, und beide sind Absicht:
 *
 *  1. Ein Entwurf **behält** seinen Firmenstand. Das ist die bestehende Regel,
 *     und die ersten beiden Tests schreiben sie zum ersten Mal fest.
 *  2. Für rechnungskritische Felder — Firmierung, Anschrift, Steuerdaten,
 *     Bankverbindung — ist dieser Stand irgendwann **falsch**. Genau dafür
 *     stellt der Driftdienst die Abweichung fest.
 *
 * Synthetische Daten, kein Netz.
 */

const PROFILE_A: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Çırmak Haustechnik GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '33602',
  city: 'Bielefeld',
  country: 'Deutschland',
  taxNumber: '305/5678/9012',
  vatId: 'DE123456789',
  bankName: 'Sparkasse Lemgo',
  iban: 'DE89 4765 0130 0001 2345 67',
  bic: 'WELADED1LIP',
  defaultPaymentDays: 14,
};

function seedProfile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  const profile = { ...PROFILE_A, ...overrides };
  hydrateCompanyProfileStore(profile);
  return profile;
}

beforeEach(() => {
  resetTestStores();
  seedProfile();
  hydrateVorgangStore([createTestVorgangWithExecutedQuantity()]);
});

function draftNow() {
  const draft = buildInvoiceDraftForType('v-test-1', testSetup, 'rechnung');
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();
  return draft!;
}

describe('01E — J1/J2: der Entwurf behält seinen Firmenstand', () => {
  it('J1: eine spätere Profiländerung zieht einen bestehenden Entwurf nicht nach', () => {
    const draft = draftNow();
    expect(draft.companySnapshot.iban).toBe(PROFILE_A.iban);

    seedProfile({ iban: 'DE02 1203 0000 0000 2020 51', companyName: 'Çırmak Haustechnik GmbH & Co. KG' });

    /* Der gespeicherte Entwurf ist unberührt — das ist die bestehende Regel. */
    expect(draft.companySnapshot.iban).toBe(PROFILE_A.iban);
    expect(draft.companySnapshot.companyName).toBe(PROFILE_A.companyName);
  });

  it('J2: ein neuer Entwurf verwendet den neuen Stand', () => {
    seedProfile({ iban: 'DE02 1203 0000 0000 2020 51' });
    const draft = draftNow();

    expect(draft.companySnapshot.iban).toBe('DE02 1203 0000 0000 2020 51');
  });
});

describe('01E — J3 bis J12: was als Abweichung zählt', () => {
  it('J3: unverändertes Profil erzeugt keine Abweichung', () => {
    const draft = draftNow();

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([]);
  });

  const kritisch: [string, Partial<CompanyProfile>, string][] = [
    ['J4: Firmenname', { companyName: 'Çırmak Haustechnik GmbH & Co. KG' }, 'companyName'],
    ['J5a: Straße', { street: 'Mengenweg 420' }, 'street'],
    ['J5b: PLZ', { zip: '33604' }, 'zip'],
    ['J5c: Ort', { city: 'Detmold' }, 'city'],
    ['J6: IBAN', { iban: 'DE02 1203 0000 0000 2020 51' }, 'iban'],
    ['J7a: Steuernummer', { taxNumber: '305/1111/2222' }, 'taxNumber'],
    ['J7b: USt-IdNr.', { vatId: 'DE987654321' }, 'vatId'],
    ['Rechtsform', { legalForm: 'GmbH & Co. KG' }, 'legalForm'],
    ['Bank', { bankName: 'Volksbank Bielefeld' }, 'bankName'],
    ['BIC', { bic: 'GENODEM1BIE' }, 'bic'],
  ];

  for (const [label, change, field] of kritisch) {
    it(`${label} geändert → Abweichung erkannt`, () => {
      const draft = draftNow();
      seedProfile(change);

      expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([
        field,
      ]);
    });
  }

  const unkritisch: [string, Partial<CompanyProfile>][] = [
    ['J8: nur Logo', { logoDataUrl: 'data:image/png;base64,NEU' }],
    ['J8b: nur Primärfarbe', { branding: { primaryColor: '#ff0000' } }],
    ['J8c: nur Fußnoten', { invoiceFooterNotes: 'Neuer Hinweis' }],
    ['J9a: nur Telefon', { phone: '0521 999999' }],
    ['J9b: nur E-Mail', { email: 'neu@example.invalid' }],
    ['J9c: nur Website', { website: 'https://neu.example.invalid' }],
    ['J9d: nur Ansprechpartner', { contactPerson: 'Neue Person' }],
    ['J10: nur Zahlungsziel', { defaultPaymentDays: 30 }],
    ['J11a: nur Skonto-Prozent', { skontoPercent: 3 }],
    ['J11b: nur Skonto-Frist', { skontoDays: 5 }],
    ['J11c: nur Zahlungsbedingungen', { defaultPaymentTerms: 'Zahlbar in 30 Tagen.' }],
  ];

  for (const [label, change] of unkritisch) {
    it(`${label} geändert → keine Abweichung`, () => {
      const draft = draftNow();
      seedProfile(change);

      expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([]);
    });
  }

  it('J12: eine andere Schreibweise derselben IBAN ist keine Abweichung', () => {
    const draft = draftNow();
    seedProfile({ iban: 'de8947650130000123456 7'.replace(' ', ''), bic: ' weladed1lip ' });

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([]);
  });

  it('J12b: leer und nicht gesetzt gelten als derselbe Zustand', () => {
    const draft = draftNow();
    seedProfile({ bic: '   ' });
    const ohneBic = { ...draft.companySnapshot, bic: '' };

    expect(findCriticalCompanyProfileDrift(ohneBic, getCompanyProfile())).toEqual([]);
  });

  it('aber: eine echte Firmierungsänderung wird nicht wegnormalisiert', () => {
    const draft = draftNow();
    seedProfile({ companyName: 'Çırmak  Haustechnik GmbH' });

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([
      'companyName',
    ]);
  });
});

describe('01E — J13/J14: Übernahme betrifft nur die kritischen Felder', () => {
  it('J13/J14: kritische Felder werden ersetzt, Rechnungsentscheidungen nicht', () => {
    const draft = draftNow();
    const neu = seedProfile({
      companyName: 'Çırmak Haustechnik GmbH & Co. KG',
      iban: 'DE02 1203 0000 0000 2020 51',
      /* Alles Folgende darf die Übernahme **nicht** anfassen. */
      defaultPaymentDays: 30,
      skontoPercent: 3,
      skontoDays: 5,
      defaultPaymentTerms: 'Zahlbar in 30 Tagen.',
      phone: '0521 999999',
      invoiceFooterNotes: 'Neuer Hinweis',
      logoDataUrl: 'data:image/png;base64,NEU',
    });

    const updated = applyCriticalCompanyProfileFields(draft.companySnapshot, neu);

    /* Übernommen: */
    expect(updated.companyName).toBe('Çırmak Haustechnik GmbH & Co. KG');
    expect(updated.iban).toBe('DE02 1203 0000 0000 2020 51');
    /* Unberührt — Standardwerte des Betriebs sind keine Absenderidentität: */
    expect(updated.defaultPaymentDays).toBe(PROFILE_A.defaultPaymentDays);
    expect(updated.defaultPaymentTerms).toBe(draft.companySnapshot.defaultPaymentTerms);
    expect(updated.skontoPercent).toBe(draft.companySnapshot.skontoPercent);
    expect(updated.skontoDays).toBe(draft.companySnapshot.skontoDays);
    expect(updated.phone).toBe(draft.companySnapshot.phone);
    expect(updated.invoiceFooterNotes).toBe(draft.companySnapshot.invoiceFooterNotes);
    expect(updated.logoDataUrl).toBe(draft.companySnapshot.logoDataUrl);
    expect(updated.branding).toEqual(draft.companySnapshot.branding);

    /* Nach der Übernahme ist die Abweichung verschwunden. */
    expect(findCriticalCompanyProfileDrift(updated, neu)).toEqual([]);
  });

  it('die Rechnungsentscheidungen des Entwurfs bleiben ausserhalb des Snapshots ohnehin unberührt', () => {
    const draft = draftNow();
    const vorher = {
      paymentDueDate: draft.paymentDueDate,
      paymentTermsText: draft.paymentTermsText,
      skontoText: draft.skontoText,
      positions: draft.positions.length,
    };
    seedProfile({ defaultPaymentDays: 30, iban: 'DE02 1203 0000 0000 2020 51' });
    const updated = {
      ...draft,
      companySnapshot: applyCriticalCompanyProfileFields(draft.companySnapshot, getCompanyProfile()),
    };

    expect(updated.paymentDueDate).toBe(vorher.paymentDueDate);
    expect(updated.paymentTermsText).toBe(vorher.paymentTermsText);
    expect(updated.skontoText).toBe(vorher.skontoText);
    expect(updated.positions).toHaveLength(vorher.positions);
    expect(updated.brandingSnapshot).toEqual(draft.brandingSnapshot);
  });
});

describe('01E2 — I9: die finalisierte Rechnung bleibt bei ihrem Stand', () => {
  it('eine spätere Profiländerung ändert eine bereits finalisierte Rechnung nicht', () => {
    const draft = draftNow();
    const finalisierbar: typeof draft = {
      ...draft,
      positions: draft.positions.map((p) => ({ ...p, quantity: p.quantity > 0 ? p.quantity : 1 })),
      servicePeriodFrom: '2026-08-01',
      servicePeriodTo: '2026-08-20',
      servicePeriodConfirmed: true,
    };

    const finalized = finalizeInvoiceDraft('v-test-1', finalisierbar, testSetup);
    expect(finalized, JSON.stringify(finalized)).toMatchObject({ ok: true });
    if (!finalized.ok) return;
    expect(finalized.invoice.companySnapshot?.iban).toBe(PROFILE_A.iban);

    /* Der Betrieb ändert danach Firmierung und Bankverbindung. */
    seedProfile({
      companyName: 'Gamma Betrieb GmbH',
      iban: 'DE03 3003 0000 0000 3030 30',
      taxNumber: '33/333/33333',
    });

    /* Die Rechnung bleibt, was sie war — das ist unverhandelbar. */
    expect(finalized.invoice.companySnapshot?.companyName).toBe(PROFILE_A.companyName);
    expect(finalized.invoice.companySnapshot?.iban).toBe(PROFILE_A.iban);
    expect(finalized.invoice.companySnapshot?.taxNumber).toBe(PROFILE_A.taxNumber);
  });
});

describe('01E — H: eine Bestätigung gilt nur für den verglichenen Stand', () => {
  it('nach einer erneuten Profiländerung passt das Kennzeichen nicht mehr', () => {
    const bestaetigt = buildCriticalCompanyFingerprint(getCompanyProfile());

    seedProfile({ iban: 'DE02 1203 0000 0000 2020 51' });
    const nachB = buildCriticalCompanyFingerprint(getCompanyProfile());
    expect(nachB).not.toBe(bestaetigt);

    seedProfile({ iban: 'DE02 1203 0000 0000 2020 51', companyName: 'Dritter Name GmbH' });
    expect(buildCriticalCompanyFingerprint(getCompanyProfile())).not.toBe(nachB);
  });

  it('unkritische Änderungen ändern das Kennzeichen nicht', () => {
    const vorher = buildCriticalCompanyFingerprint(getCompanyProfile());
    seedProfile({ phone: '0521 999999', defaultPaymentDays: 30 });

    expect(buildCriticalCompanyFingerprint(getCompanyProfile())).toBe(vorher);
  });
});

/**
 * COMPANY-PROFILE-REGISTER-01I — Registergericht und Registernummer.
 *
 * Sie stehen hier und nicht in einer eigenen Datei, weil sie fachlich genau
 * dasselbe sind wie Firmierung und Steuernummer: rechtliche Absenderidentität.
 * Eine zweite Driftarchitektur gäbe es damit nicht, nur zwei Listen, die
 * auseinanderlaufen könnten.
 */
describe('01I — Registerangaben als kritische Stammdaten', () => {
  const MIT_REGISTER: Partial<CompanyProfile> = {
    registrationAuthority: 'Amtsgericht Lemgo',
    registrationNumber: 'HRB 12345',
  };

  it('F1: ein neuer Entwurf übernimmt beide Registerfelder in den Snapshot', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();

    expect(draft.companySnapshot.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(draft.companySnapshot.registrationNumber).toBe('HRB 12345');
  });

  it('F2: eine finalisierte Rechnung behält ihre Registerangaben für immer', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    const finalisierbar: typeof draft = {
      ...draft,
      positions: draft.positions.map((p) => ({ ...p, quantity: p.quantity > 0 ? p.quantity : 1 })),
      servicePeriodFrom: '2026-08-01',
      servicePeriodTo: '2026-08-20',
      servicePeriodConfirmed: true,
    };

    const finalized = finalizeInvoiceDraft('v-test-1', finalisierbar, testSetup);
    expect(finalized, JSON.stringify(finalized)).toMatchObject({ ok: true });
    if (!finalized.ok) return;

    /* Der Betrieb wechselt danach das Register — Sitzverlegung. */
    seedProfile({
      registrationAuthority: 'Amtsgericht Bielefeld',
      registrationNumber: 'HRB 99999',
    });

    expect(finalized.invoice.companySnapshot?.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(finalized.invoice.companySnapshot?.registrationNumber).toBe('HRB 12345');
  });

  it('L1: geändertes Registergericht ist eine Abweichung', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    seedProfile({ ...MIT_REGISTER, registrationAuthority: 'Amtsgericht Bielefeld' });

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([
      'registrationAuthority',
    ]);
  });

  it('L2: geänderte Registernummer ist eine Abweichung', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    seedProfile({ ...MIT_REGISTER, registrationNumber: 'HRB 12346' });

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([
      'registrationNumber',
    ]);
  });

  it('L3: nur äußere Leerzeichen sind keine Abweichung', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    seedProfile({
      registrationAuthority: '  Amtsgericht Lemgo  ',
      registrationNumber: ' HRB 12345 ',
    });

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([]);
  });

  it('L3b: ein nie befülltes Registerfeld erzeugt keine Abweichung', () => {
    const draft = draftNow();

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([]);
  });

  it('L3c: die Schreibweise zählt — „HRB" und „hrb" sind nicht dasselbe', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    seedProfile({ ...MIT_REGISTER, registrationNumber: 'hrb 12345' });

    expect(findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile())).toEqual([
      'registrationNumber',
    ]);
  });

  it('L4: Übernehmen setzt die aktuellen Registerwerte in den Snapshot', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    const aktuell = seedProfile({
      registrationAuthority: 'Amtsgericht Bielefeld',
      registrationNumber: 'HRB 99999',
    });

    const next = applyCriticalCompanyProfileFields(draft.companySnapshot, aktuell);

    expect(next.registrationAuthority).toBe('Amtsgericht Bielefeld');
    expect(next.registrationNumber).toBe('HRB 99999');
    /* Unkritisches bleibt beim Entwurfsstand. */
    expect(next.defaultPaymentDays).toBe(draft.companySnapshot.defaultPaymentDays);
  });

  it('L4b: eine gelöschte Registerangabe verschwindet beim Übernehmen auch aus dem Entwurf', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    const aktuell = seedProfile({ registrationAuthority: '', registrationNumber: '' });

    const next = applyCriticalCompanyProfileFields(draft.companySnapshot, aktuell);

    expect(next.registrationAuthority).toBe('');
    expect(next.registrationNumber).toBe('');
  });

  it('L5: Behalten lässt die bisherigen Registerwerte unangetastet', () => {
    seedProfile(MIT_REGISTER);
    const draft = draftNow();
    seedProfile({
      registrationAuthority: 'Amtsgericht Bielefeld',
      registrationNumber: 'HRB 99999',
    });

    /* „Behalten" heißt: am Entwurf passiert nichts. */
    expect(draft.companySnapshot.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(draft.companySnapshot.registrationNumber).toBe('HRB 12345');
  });

  it('das Kennzeichen ändert sich mit den Registerangaben', () => {
    seedProfile(MIT_REGISTER);
    const vorher = buildCriticalCompanyFingerprint(getCompanyProfile());
    seedProfile({ ...MIT_REGISTER, registrationNumber: 'HRB 12346' });

    expect(buildCriticalCompanyFingerprint(getCompanyProfile())).not.toBe(vorher);
  });
});
