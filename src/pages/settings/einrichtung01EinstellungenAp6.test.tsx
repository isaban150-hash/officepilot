/**
 * EINRICHTUNG-01 (AP6; Verträge 1.18, 1.21, 1.22) — die AP6-Einstellungsseiten in der echten Shell.
 *
 *   F-01.1/F-01.2  Fehler anderer Seiten als Liste mit Seite, Feld und Sprung; der Sprung fokussiert das Feld
 *   F-02 / F-02.8  Formatfehler am Feld sperren das Speichern; gültige Grenzwerte bleiben nach Neuaufbau gleich
 *   F-03.1         IBAN in Vierergruppen angezeigt, elektronisch gespeichert
 *   F-04.1/F-04.2  Gewerk, Material, Kanal (ohne WhatsApp) änderbar; Mitglieder nur lesend
 *   V-01.1/V-01.2/V-01.4  Seiten „Angebote und Aufträge“ und „Briefe“
 *   V-06.2/V-07.1/V-07.2  Nummernkreise: übersetzte Fehler, Startnummer bis zur ersten Vergabe
 *   E-01.1/E-02/E-03/E-05.2/E-06  Kommunikationsseite
 *
 * Lokaler Betrieb, wo nicht anders angegeben; Netz und Edge Functions gemockt.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { AppShell } from '../../components/layout/AppShell';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { CompanySettingsPage } from './CompanySettingsPage';
import { InvoiceSettingsPage } from './InvoiceSettingsPage';
import { OfferSettingsPage } from './OfferSettingsPage';
import { LetterSettingsPage } from './LetterSettingsPage';
import { NumberRangeSettingsPage } from './NumberRangeSettingsPage';
import { CommunicationSettingsPage } from './CommunicationSettingsPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import { createMockSupabaseClient } from '../../test/mockSupabaseAuth';
import * as companyProfileService from '../../services/companyProfileService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { getCachedSetup } from '../../services/persistenceService';
import { getInvoiceNumberSequenceSnapshot, hydrateInvoiceNumberSequence, getCurrentInvoiceYear } from '../../services/invoiceNumberService';
import { invoiceNumberRangeErrorKey } from '../../services/invoice/invoiceNumberRangeErrors';
import * as mailStatus from '../../services/delivery/mailStatusService';
import * as replyTo from '../../services/delivery/replyToConfirmationService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { resetUiSessionLiveState } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import type { CompanyProfile } from '../../types/models';

const USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-0000000006a6';
const setup = { ...DEFAULT_SETUP, setupComplete: true, industry: 'Elektro', communicationChannel: 'email' as const, materialStandard: 'betrieb' as const };
const P = SETTINGS_TARGET_PATHS;

const SAVED: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Haustechnik',
  legalForm: 'GmbH',
  street: 'Musterstraße 5',
  zip: '33602',
  city: 'Bielefeld',
  country: 'Deutschland',
  contactPerson: 'Erika Beispiel',
  email: 'info@muster-haustechnik.invalid',
  taxNumber: '133/8150/8159',
  bankName: 'Musterbank',
  iban: 'DE89370400440532013000',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
};

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

let root: Root | null = null;
let host: HTMLDivElement;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} data-hash={location.hash} />;
}

function routes(): ReactNode {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<div data-testid="home-stub" />} />
        <Route path="/einstellungen" element={<div data-testid="hub-stub" />} />
        <Route path={P['company-profile']} element={<CompanySettingsPage />} />
        <Route path={P.invoices} element={<InvoiceSettingsPage />} />
        <Route path={P.offers} element={<OfferSettingsPage />} />
        <Route path={P.letters} element={<LetterSettingsPage />} />
        <Route path={P['number-ranges']} element={<NumberRangeSettingsPage />} />
        <Route path={P.communication} element={<CommunicationSettingsPage />} />
      </Route>
    </Routes>
  );
}

async function settle(rounds = 8): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderAt(entry: string): Promise<void> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            {routes()}
            <LocationProbe />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const pathNow = () => q('location')?.getAttribute('data-path') ?? '';

async function type(id: string, value: string): Promise<void> {
  const element = q(id) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(element, id).not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function select(id: string, value: string): Promise<void> {
  const element = q(id) as HTMLSelectElement | null;
  expect(element, id).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value);
    element!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function blur(id: string): Promise<void> {
  await act(async () => {
    q(id)!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    q(id)!.dispatchEvent(new FocusEvent('blur'));
  });
}

async function click(id: string): Promise<void> {
  const element = q(id);
  expect(element, id).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'guest' });
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
  mailStatus.resetMailStatusForTests();
  hydrateCompanyProfileStore(SAVED);
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  await loginAsDefaultAdmin();
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  clearUiSessionSnapshot();
  resetUiSessionLiveState();
  resetTestStores();
});

describe('EINRICHTUNG-01 (AP6; 1.18) — Firmendaten', { timeout: 30_000 }, () => {
  it('F-01.1/F-01.2: Fehler auf der Rechnungsseite — Liste mit Seite, Feld und Sprung; der Sprung fokussiert das Feld', async () => {
    hydrateCompanyProfileStore({ ...SAVED, skontoEnabled: true, skontoPercent: 2, skontoDays: 30 });
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(P['company-profile']);
    await type('settings-company-city', 'Gütersloh');
    await click('settings-company-save');

    const list = q('settings-company-foreign-errors');
    expect(list).not.toBeNull();
    expect(q('settings-company-foreign-errors-skontoDays')?.textContent).toContain('Rechnungen und Zahlungen');
    expect(host.textContent).not.toContain('markierten Felder');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(getCompanyProfile().city).toBe('Bielefeld');

    await click('settings-company-foreign-errors-jump-skontoDays');
    await act(async () => {
      await new Promise((done) => setTimeout(done, 40));
    });
    expect(pathNow()).toBe(P.invoices);
    expect(q('location')?.getAttribute('data-hash')).toBe('#settings-invoices-skontoDays');
    expect(document.activeElement?.id).toBe('settings-invoices-skontoDays');
  });

  it('F-02.6: Website „javascript:alert(1)“ — Fehler am Feld, nichts gespeichert', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(P['company-profile']);
    await type('settings-company-website', 'javascript:alert(1)');
    await click('settings-company-save');
    expect(q('settings-company-website-error')).not.toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('F-02.8/F-03.1: gültige Grenzwerte und IBAN — gespeichert in Normalform, nach Neuaufbau gleich', async () => {
    await renderAt(P['company-profile']);
    await type('settings-company-vatId', 'de123456789');
    await type('settings-company-phone', '123456');
    await type('settings-company-website', 'https://www.muster-haustechnik.invalid');
    await type('settings-company-iban', 'de89 3704 0044 0532 0130 00');
    await blur('settings-company-iban');
    expect((q('settings-company-iban') as HTMLInputElement).value).toBe('DE89 3704 0044 0532 0130 00');
    await click('settings-company-save');

    expect(q('settings-company-website-error')).toBeNull();
    expect(getCompanyProfile().iban).toBe('DE89370400440532013000');
    expect(getCompanyProfile().vatId).toBe('DE123456789');
    expect(getCompanyProfile().phone).toBe('123456');
    await unmount();
    await renderAt(P['company-profile']);
    expect((q('settings-company-vatId') as HTMLInputElement).value).toBe('DE123456789');
    expect((q('settings-company-website') as HTMLInputElement).value).toBe('https://www.muster-haustechnik.invalid');
  });

  it('F-04.1: Gewerk, Material und Kanal werden gespeichert; WhatsApp ist nicht wählbar', async () => {
    await renderAt(P['company-profile']);
    expect(q('settings-company-channel-whatsapp')).toBeNull();
    expect(q('settings-company-channel-email')?.getAttribute('aria-pressed')).toBe('true');
    await click('settings-company-channel-letter');
    await click('settings-company-material-gemischt');
    const industry = q('settings-company-industry') as HTMLSelectElement;
    const other = Array.from(industry.options).map((option) => option.value).find((value) => value && value !== 'Elektro');
    expect(other).toBeTruthy();
    await select('settings-company-industry', other!);
    await click('settings-company-save');

    const saved = getCachedSetup();
    expect(saved?.communicationChannel).toBe('letter');
    expect(saved?.materialStandard).toBe('gemischt');
    expect(saved?.industry).toBe(other);
  });

  it('F-04.2: Mitglieder sehen die Arbeitsweise nur lesend', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('member');
    await renderAt(P['company-profile']);
    expect((q('settings-company-section-operations') as HTMLFieldSetElement).disabled).toBe(true);
    expect((q('settings-company-channel-letter') as HTMLButtonElement).disabled).toBe(true);
    expect(q('settings-company-save')).toBeNull();
  });
});

describe('EINRICHTUNG-01 (AP6; 1.21) — Angebote, Aufträge, Briefe', { timeout: 30_000 }, () => {
  it('V-01.1: Gültigkeit 14, Einleitung und Schluss für Angebote und Aufträge werden gespeichert', async () => {
    await renderAt(P.offers);
    await type('settings-offers-offerValidityDays', '14');
    await type('settings-offers-offerIntroText', 'Gern bieten wir Ihnen an:');
    await type('settings-offers-offerClosingText', 'Wir freuen uns auf Ihren Auftrag.');
    await type('settings-offers-orderIntroText', 'Vielen Dank für Ihren Auftrag.');
    await type('settings-offers-orderClosingText', 'Mit freundlichen Grüßen');
    await click('settings-offers-save');
    expect(getCompanyProfile()).toMatchObject({
      offerValidityDays: 14,
      offerIntroText: 'Gern bieten wir Ihnen an:',
      offerClosingText: 'Wir freuen uns auf Ihren Auftrag.',
      orderIntroText: 'Vielen Dank für Ihren Auftrag.',
      orderClosingText: 'Mit freundlichen Grüßen',
    });
  });

  it('V-01.2: Gültigkeit 0, 366 und „abc“ — Fehler am Feld, nichts gespeichert', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(P.offers);
    for (const value of ['0', '366', 'abc']) {
      await type('settings-offers-offerValidityDays', value);
      await click('settings-offers-save');
      expect(q('settings-offers-offerValidityDays-error'), value).not.toBeNull();
    }
    expect(updateSpy).not.toHaveBeenCalled();
    expect(getCompanyProfile().offerValidityDays).toBeUndefined();
  });

  it('V-01.4: Anrede und Grußformel für Briefe werden gespeichert; 2001 Codepunkte abgewiesen', async () => {
    await renderAt(P.letters);
    await type('settings-letters-letterSalutation', 'Sehr geehrte Damen und Herren,');
    await type('settings-letters-letterClosing', 'Mit freundlichen Grüßen');
    await click('settings-letters-save');
    expect(getCompanyProfile()).toMatchObject({ letterSalutation: 'Sehr geehrte Damen und Herren,', letterClosing: 'Mit freundlichen Grüßen' });

    await type('settings-letters-letterClosing', 'ä'.repeat(2001));
    await click('settings-letters-save');
    expect(q('settings-letters-letterClosing-error')).not.toBeNull();
    expect(getCompanyProfile().letterClosing).toBe('Mit freundlichen Grüßen');
  });
});

describe('EINRICHTUNG-01 (AP6; 1.21) — Nummernkreise', { timeout: 30_000 }, () => {
  it('V-06.2: jeder RPC-Fehler wird übersetzt, nie roh gezeigt', () => {
    const cases: Array<[string, string]> = [
      ['workspace_license_not_effective', 'settings.numberRanges.error.license'],
      ['account_blocked', 'settings.numberRanges.error.account'],
      ['forbidden_role', 'settings.numberRanges.error.role'],
      ['invoice_number_start_locked', 'settings.numberRanges.error.locked'],
      ['version_conflict', 'settings.numberRanges.error.conflict'],
      ['PGRST202', 'settings.numberRanges.error.unsupported'],
      ['invalid_format', 'settings.numberRanges.error.invalid'],
      ['Failed to fetch', 'settings.numberRanges.error.network'],
      ['etwas anderes', 'settings.numberRanges.error.failed'],
    ];
    for (const [message, key] of cases) expect(invoiceNumberRangeErrorKey(message), message).toBe(key);
  });

  it('V-07.1: vor der ersten Vergabe ist die Startnummer änderbar; die Vorschau folgt', async () => {
    const year = getCurrentInvoiceYear();
    hydrateInvoiceNumberSequence({ year, lastIssuedNumber: 0 });
    await renderAt(P['number-ranges']);
    expect(q('settings-number-ranges-start-locked')).toBeNull();
    await type('settings-number-ranges-start', '41');
    await click('settings-number-ranges-start-save');
    expect(getInvoiceNumberSequenceSnapshot()).toMatchObject({ year, lastIssuedNumber: 41 });
    expect(q('settings-number-ranges-next')?.textContent).toContain('42');
  });

  it('V-07.2: nach der ersten Vergabe gesperrt, mit Erklärung', async () => {
    hydrateInvoiceNumberSequence({ year: getCurrentInvoiceYear(), lastIssuedNumber: 3 });
    await renderAt(P['number-ranges']);
    expect(q('settings-number-ranges-start-locked')?.textContent).toContain('in Benutzung');
    expect((q('settings-number-ranges-start') as HTMLInputElement).disabled).toBe(true);
    expect(q('settings-number-ranges-start-save')).toBeNull();
  });
});

describe('EINRICHTUNG-01 (AP6; 1.22) — Kommunikation', { timeout: 30_000 }, () => {
  it('E-01.1: der Hinweistext entspricht 1.22', async () => {
    await renderAt(P.communication);
    expect(q('settings-communication-sender-hint')?.textContent).toContain(
      'Anzeigename und Antwortadresse gelten für alle E-Mails aus OfficeTakt, auch für Rechnungen. Im Rechnungs-PDF stehen die Firmendaten vom Zeitpunkt der Freigabe.',
    );
  });

  it('E-02.1c/E-02.2: Betreff mit 256 Codepunkten oder Zeilenumbruch — Fehler am Feld, nichts gespeichert', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(P.communication);
    await type('settings-communication-defaultOfferEmailSubject', '€'.repeat(256));
    await click('settings-communication-save');
    expect(q('settings-communication-defaultOfferEmailSubject-error')).not.toBeNull();
    // Ein Eingabefeld entfernt CR/LF schon selbst; der Zeilentrenner U+2028 kommt durch (etwa beim Einfügen).
    await type('settings-communication-defaultOfferEmailSubject', `Angebot${String.fromCharCode(0x2028)}Nummer`);
    await click('settings-communication-save');
    expect(q('settings-communication-defaultOfferEmailSubject-error')).not.toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();

    await type('settings-communication-defaultOfferEmailSubject', '€'.repeat(255));
    await click('settings-communication-save');
    expect(q('settings-communication-defaultOfferEmailSubject-error')).toBeNull();
    expect(getCompanyProfile().defaultOfferEmailSubject).toBe('€'.repeat(255));
  });

  it('E-04.1: Anzeigename mit „@“ — Fehler am Feld', async () => {
    await renderAt(P.communication);
    await type('settings-communication-senderDisplayName', 'info@muster.de');
    await click('settings-communication-save');
    expect(q('settings-communication-senderDisplayName-error')).not.toBeNull();
    expect(getCompanyProfile().senderDisplayName ?? '').toBe('');
  });

  it('E-05: Sprache der E-Mail-Vorgaben speichern; Mitglieder können sie nicht ändern (E-05.2)', async () => {
    await renderAt(P.communication);
    await select('settings-communication-communicationLanguage', 'tr');
    await click('settings-communication-save');
    expect(getCompanyProfile().communicationLanguage).toBe('tr');
    await unmount();

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('member');
    await renderAt(P.communication);
    expect((q('settings-communication-communicationLanguage') as HTMLSelectElement).disabled).toBe(true);
    expect(q('settings-communication-save')).toBeNull();
  });

  it('E-06.1/E-06.2: Testmodus-Hinweis nach Meldung des Servers — ohne Adressen', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('owner');
    // Der Server meldet den Modus über die Edge Function `mail-status` (Funktionsweg des Supabase-Clients).
    let mode = 'stub';
    const invoke = vi.fn(async () => ({ data: { ok: true, mode }, error: null }));
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(() => ({ ...createMockSupabaseClient(), functions: { invoke } }) as never);
    vi.spyOn(replyTo, 'loadReplyToStatus').mockResolvedValue(null);
    await renderAt(P.communication);
    expect(invoke).toHaveBeenCalledWith('mail-status', { body: { workspaceId: WORKSPACE_ID } });
    expect(q('settings-communication-test-mode')?.textContent).toContain('Testmodus: E-Mails werden nicht zugestellt');
    await unmount();

    mode = 'test_recipients';
    mailStatus.resetMailStatusForTests();
    await renderAt(P.communication);
    expect(q('settings-communication-test-mode')?.textContent).toContain('nur an freigegebene Testempfänger');
    expect(q('settings-communication-test-mode')?.textContent).not.toContain('@');
    await unmount();

    mode = 'live';
    mailStatus.resetMailStatusForTests();
    await renderAt(P.communication);
    expect(q('settings-communication-test-mode')).toBeNull();
  });

  it('E-03 (V): unbestätigte Antwortadresse — Stand, Rückfall auf die Anmelde-E-Mail des Inhabers, „Erneut senden“ erst nach der Frist', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('owner');
    hydrateCompanyProfileStore({ ...SAVED, replyToEmail: 'antwort@muster-haustechnik.invalid' });
    vi.spyOn(replyTo, 'loadReplyToStatus').mockResolvedValue({
      address: 'antwort@muster-haustechnik.invalid',
      confirmed: false,
      pending: true,
      lastSentAt: '2026-10-25T08:00:00.000Z',
      canResendAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      sendsToday: 1,
      effectiveSource: 'owner_login',
      effectiveMasked: 'i***@muster-haustechnik.invalid',
      unavailable: false,
    });
    await renderAt(P.communication);
    expect(q('settings-communication-replyTo-state')?.getAttribute('data-confirmed')).toBe('false');
    expect(q('settings-communication-replyTo-fallback')?.textContent).toContain('i***@muster-haustechnik.invalid');
    expect((q('settings-communication-replyTo-resend') as HTMLButtonElement).disabled).toBe(true);
    expect(q('settings-communication-identity-replyTo')?.textContent).toContain('i***@muster-haustechnik.invalid');
  });

  // EINRICHTUNG-01 (Eigenprüfung; E-03) — im echten Browser ging die Anforderung vor dem Abgleich der ERSTEN Adresse
  // hinaus; der Server meldete „reply_to_missing“, und die Seite zeigte „Bitte zuerst … speichern“ ohne Nachfassen.
  it('E-03 (V): erste Antwortadresse — „reply_to_missing“ während des Abgleichs wird wiederholt, danach gesendet', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('owner');
    vi.spyOn(replyTo, 'loadReplyToStatus').mockResolvedValue(null);
    const anfrage = vi
      .spyOn(replyTo, 'requestReplyToConfirmation')
      .mockResolvedValueOnce({ result: 'missing' })
      .mockResolvedValueOnce({ result: 'sent' });
    await renderAt(P.communication);
    await type('settings-communication-replyToEmail', 'antwort@muster-haustechnik.invalid');
    await click('settings-communication-save');
    expect(anfrage).toHaveBeenCalledTimes(1);
    expect(q('settings-communication-replyTo-request-info')?.textContent).toBe('Die neue Adresse wird abgeglichen; die Bestätigungsmail folgt gleich.');
    await act(async () => {
      await new Promise((done) => setTimeout(done, 3200));
    });
    await settle();
    expect(anfrage).toHaveBeenCalledTimes(2);
    expect(anfrage).toHaveBeenLastCalledWith('antwort@muster-haustechnik.invalid', 'de');
    expect(q('settings-communication-replyTo-request-info')?.textContent).not.toContain('Bitte zuerst');
    expect(q('settings-communication-replyTo-request-info')?.getAttribute('role')).toBe('status');
  });
});
