/**
 * BROWSER-ACCEPTANCE-FIX 01 / B2 — IBAN und Rechtsform-Angaben im Firmenprofil.
 *
 * Die IBAN wird fachlich geprüft (Land, Länge, Mod-97), eine ungültige kann in
 * den Firmendaten nicht bestätigt werden, eine bereits gespeicherte ungültige
 * wird sichtbar gemacht — aber nicht verändert. Auf Rechnungen erscheint vor
 * der Freigabe ein Hinweis. Für eine GmbH ohne Geschäftsführer/Register gibt
 * es einen sichtbaren, nicht blockierenden Hinweis.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from './lib/supabase';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BETA_TEST_COMPANY_PROFILE, BETA_TEST_SETUP } from './config/betaTestMode';
import { CompanySettingsPage, missingCapitalCompanyFields } from './pages/settings/CompanySettingsPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { ibanErrorKey, validateCompanyProfileForSettings } from './services/setupValidationService';
import { validateInvoiceDraftForApproval } from './services/invoiceValidationService';
import { checkIban, isValidIban, normalizeIban } from './utils/iban';
import { createNormalPrintSetup } from './test/invoicePrintFixtures';
import { createTestVorgang } from './test/fixtures';

const VALID_DE = 'DE89370400440532013000';
const TOO_LONG_DE = 'DE893704004405320130001'; // 23 Zeichen — die Lage der Browser-Abnahme
const BAD_CHECKSUM_DE = 'DE88370400440532013000';

describe('BROWSER-ACCEPTANCE-FIX 01 / B2 — IBAN-Prüfung', () => {
  it('B2-1: gültige deutsche IBAN, auch mit Leerzeichen und Kleinbuchstaben', () => {
    expect(isValidIban(VALID_DE)).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('de89 3704 0044 0532 0130 00')).toBe(true);
    expect(normalizeIban(' de89 3704 0044 0532 0130 00 ')).toBe(VALID_DE);
    expect(isValidIban('DE02120300000000202051')).toBe(true);
  });

  it('B2-2: falsche deutsche Länge — nicht nur „length === 22", sondern je Land', () => {
    expect(checkIban(TOO_LONG_DE)).toMatchObject({ valid: false, problem: 'length', expectedLength: 22 });
    expect(checkIban('DE8937040044053201300')).toMatchObject({ valid: false, problem: 'length' });
    expect(ibanErrorKey(TOO_LONG_DE)).toBe('setup.error.ibanLengthDe');
    // Eine 22-stellige Nummer eines anderen Landes ist dort falsch lang.
    expect(checkIban('AT891904300234573201XX')).toMatchObject({ valid: false, problem: 'length' });
  });

  it('B2-3: falsche Prüfziffer (Mod-97)', () => {
    expect(checkIban(BAD_CHECKSUM_DE)).toMatchObject({ valid: false, problem: 'checksum' });
    // Zahlendreher in der Kontonummer.
    expect(checkIban('DE89370400440532031000')).toMatchObject({ valid: false, problem: 'checksum' });
    expect(ibanErrorKey(BAD_CHECKSUM_DE)).toBe('setup.error.ibanChecksum');
  });

  it('B2-4: ungültige Zeichen, Aufbau und Ländercode', () => {
    expect(checkIban('DE89-3704-0044-0532-0130-00')).toMatchObject({ problem: 'characters' });
    expect(checkIban('DE89 3704 0044 0532 0130 0Ä')).toMatchObject({ problem: 'characters' });
    expect(checkIban('1289370400440532013000')).toMatchObject({ problem: 'format' });
    expect(checkIban('XX89370400440532013000')).toMatchObject({ problem: 'country' });
    expect(ibanErrorKey('DE89/370400440532013000')).toBe('setup.error.ibanCharacters');
  });

  it('B2-5: andere Länder mit eigener Länge', () => {
    expect(isValidIban('AT611904300234573201')).toBe(true); // 20
    expect(isValidIban('CH9300762011623852957')).toBe(true); // 21
    expect(isValidIban('GB82WEST12345698765432')).toBe(true); // 22, mit Buchstaben
    expect(isValidIban('NL91ABNA0417164300')).toBe(true); // 18
    expect(isValidIban('FR1420041010050500013M02606')).toBe(true); // 27
  });

  it('B2-6: leer — die Bankverbindung bleibt wie bisher Pflicht in den Firmendaten', () => {
    expect(checkIban('   ')).toMatchObject({ valid: false, problem: 'empty' });
    const result = validateCompanyProfileForSettings({ ...BETA_TEST_COMPANY_PROFILE, iban: '' }, 0);
    expect(result.errors.iban).toBe('setup.error.ibanRequired');
  });

  it('B2-7: Firmendaten prüfen streng; Rechnungseinstellungen blockieren eine alte IBAN nicht', () => {
    expect(validateCompanyProfileForSettings({ ...BETA_TEST_COMPANY_PROFILE, iban: TOO_LONG_DE }, 0).errors.iban).toBe(
      'setup.error.ibanLengthDe',
    );
    expect(validateCompanyProfileForSettings({ ...BETA_TEST_COMPANY_PROFILE, iban: VALID_DE }, 0).errors.iban).toBeUndefined();
    // Auf der Rechnungsseite ist die IBAN weder sichtbar noch änderbar.
    expect(
      validateCompanyProfileForSettings({ ...BETA_TEST_COMPANY_PROFILE, iban: TOO_LONG_DE }, 0, { ibanCheck: 'shape' }).errors.iban,
    ).toBeUndefined();
  });
});

describe('BROWSER-ACCEPTANCE-FIX 01 / B2 — Rechnung', () => {
  it('B2-8: ungültige IBAN in den Firmendaten der Rechnung → Hinweis vor der Freigabe, gültige bleibt still', () => {
    const { draft } = createNormalPrintSetup();
    const valid = validateInvoiceDraftForApproval(draft, draft.companySnapshot, createTestVorgang());
    expect(valid.warnings.map((w) => w.code)).not.toContain('company_iban_invalid');
    expect(draft.companySnapshot.iban.replace(/\s/g, '')).toBe(VALID_DE);

    const invalidDraft = { ...draft, companySnapshot: { ...draft.companySnapshot, iban: TOO_LONG_DE } };
    const invalid = validateInvoiceDraftForApproval(invalidDraft, invalidDraft.companySnapshot, createTestVorgang());
    expect(invalid.warnings.map((w) => w.code)).toContain('company_iban_invalid');
    // Ein Hinweis, kein Stopp — und die IBAN selbst wird nicht umgeschrieben.
    expect(invalid.blockingErrors.map((e) => e.code)).not.toContain('company_iban_invalid');
    expect(invalidDraft.companySnapshot.iban).toBe(TOO_LONG_DE);

    const empty = validateInvoiceDraftForApproval(
      { ...draft, companySnapshot: { ...draft.companySnapshot, iban: '' } },
      draft.companySnapshot,
      createTestVorgang(),
    );
    expect(empty.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['company_iban']));
    expect(empty.warnings.map((w) => w.code)).not.toContain('company_iban_invalid');
  });
});

describe('BROWSER-ACCEPTANCE-FIX 01 / B2 — GmbH-Angaben', () => {
  it('B2-9: fehlende Angaben nur bei GmbH/UG, nur die tatsächlich fehlenden', () => {
    const base = { legalForm: 'GmbH', managingDirector: '', registrationAuthority: '', registrationNumber: '' };
    expect(missingCapitalCompanyFields(base).map((f) => f.key)).toEqual([
      'managingDirector',
      'registrationAuthority',
      'registrationNumber',
    ]);
    expect(missingCapitalCompanyFields({ ...base, managingDirector: 'Max Beispiel' }).map((f) => f.key)).toEqual([
      'registrationAuthority',
      'registrationNumber',
    ]);
    expect(missingCapitalCompanyFields({ ...base, legalForm: 'UG (haftungsbeschränkt)' })).toHaveLength(3);
    expect(missingCapitalCompanyFields({ ...base, legalForm: 'Einzelunternehmen' })).toEqual([]);
    expect(missingCapitalCompanyFields({ ...base, legalForm: '' })).toEqual([]);
    // Leeres Rechtsform-Feld: die Rechtsform im Firmennamen zählt (Lage des Testprofils).
    expect(missingCapitalCompanyFields({ ...base, legalForm: '', companyName: 'Muster Bau GmbH' })).toHaveLength(3);
    // Ein ausgefülltes Feld hat Vorrang vor dem Namen.
    expect(missingCapitalCompanyFields({ ...base, legalForm: 'Einzelunternehmen', companyName: 'Muster GmbH' })).toEqual([]);
    expect(
      missingCapitalCompanyFields({ legalForm: 'GmbH', managingDirector: 'A', registrationAuthority: 'Amtsgericht Lemgo', registrationNumber: 'HRB 1' }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Seite                                                                */
/* ------------------------------------------------------------------ */

type Mount = { container: HTMLDivElement; root: Root };

function mountFirma(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/einstellungen/firma']}>
        <AuthProvider>
          <AppProvider initialSetup={BETA_TEST_SETUP}>
            <Routes>
              <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function type(mount: Mount, field: string, value: string): void {
  const input = mount.container.querySelector(`#settings-company-${field}`) as HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  act(() => {
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submit(mount: Mount): void {
  const form = mount.container.querySelector('form') as HTMLFormElement;
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const byTestId = (mount: Mount, id: string) => mount.container.querySelector(`[data-testid="${id}"]`);

describe('BROWSER-ACCEPTANCE-FIX 01 / B2 — Firmendaten-Seite', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  });
  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
    vi.restoreAllMocks();
  });

  it('B2-UI-1: gespeicherte ungültige IBAN wird angezeigt, markiert — und nicht verändert', () => {
    hydrateCompanyProfileStore({ ...BETA_TEST_COMPANY_PROFILE, iban: TOO_LONG_DE });
    mounted = mountFirma();

    const input = mounted.container.querySelector('#settings-company-iban') as HTMLInputElement;
    expect(input.value).toBe(TOO_LONG_DE);
    expect(byTestId(mounted, 'settings-company-iban-check')?.textContent).toBe(
      'Die gespeicherte IBAN ist nicht gültig. Eine deutsche IBAN hat genau 22 Zeichen. Bitte die Eingabe prüfen.',
    );
    // Nur angesehen: nichts gespeichert, nichts korrigiert.
    expect(getCompanyProfile().iban).toBe(TOO_LONG_DE);
  });

  it('B2-UI-2: ungültige IBAN kann nicht bestätigt werden — verständlicher Grund, Profil unverändert', () => {
    hydrateCompanyProfileStore({ ...BETA_TEST_COMPANY_PROFILE, iban: VALID_DE });
    mounted = mountFirma();

    type(mounted, 'iban', BAD_CHECKSUM_DE);
    expect(byTestId(mounted, 'settings-company-iban-check')?.textContent).toContain('Die Prüfziffer der IBAN stimmt nicht.');
    submit(mounted);

    expect(byTestId(mounted, 'settings-company-iban-error')?.textContent).toBe(
      'Die Prüfziffer der IBAN stimmt nicht. Bitte die Eingabe prüfen – vermutlich ein Tippfehler.',
    );
    expect(getCompanyProfile().iban).toBe(VALID_DE);
  });

  it('B2-UI-3: gültige IBAN (mit Leerzeichen) wird gespeichert', () => {
    hydrateCompanyProfileStore({ ...BETA_TEST_COMPANY_PROFILE, iban: TOO_LONG_DE });
    mounted = mountFirma();

    type(mounted, 'iban', 'DE02 1203 0000 0000 2020 51');
    expect(byTestId(mounted, 'settings-company-iban-check')).toBeNull();
    submit(mounted);

    expect(byTestId(mounted, 'settings-company-iban-error')).toBeNull();
    expect(getCompanyProfile().iban.replace(/\s/g, '')).toBe('DE02120300000000202051');
  });

  it('B2-UI-4: GmbH ohne Geschäftsführer/Register — sichtbarer Hinweis, Speichern bleibt möglich', () => {
    hydrateCompanyProfileStore({
      ...BETA_TEST_COMPANY_PROFILE,
      legalForm: 'GmbH',
      managingDirector: '',
      registrationAuthority: '',
      registrationNumber: '',
    });
    mounted = mountFirma();

    expect(byTestId(mounted, 'settings-company-legal-hint')?.textContent).toBe(
      'Für diese Rechtsform sind noch keine Angaben hinterlegt zu: Geschäftsführer / Inhaber, Registergericht, Registernummer. Hinterlegte Angaben erscheinen auf Rechnungen und Briefen.',
    );

    type(mounted, 'phone', '05261 123');
    submit(mounted);
    expect(getCompanyProfile().phone).toBe('05261 123');
    expect(getCompanyProfile().managingDirector ?? '').toBe('');

    type(mounted, 'managingDirector', 'Max Beispiel');
    expect(byTestId(mounted, 'settings-company-legal-hint')?.textContent).not.toContain('Geschäftsführer');
  });

  it('B2-UI-5: kein Rechtsform-Hinweis bei anderer Rechtsform', () => {
    hydrateCompanyProfileStore({ ...BETA_TEST_COMPANY_PROFILE, legalForm: 'Einzelunternehmen', managingDirector: '' });
    mounted = mountFirma();
    expect(byTestId(mounted, 'settings-company-legal-hint')).toBeNull();
  });
});
