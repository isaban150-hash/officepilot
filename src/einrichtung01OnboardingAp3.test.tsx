/**
 * EINRICHTUNG-01 (AP3) — Einrichtungsassistent nach Katalog V3, Abschnitt O:
 *  - O-01 Entwurf je Konto und Betrieb: Fortsetzen nach Schließen, kein fremder Entwurf, Speicherfehler beim Abschluss;
 *  - O-02 Vorbelegung aus der Registrierung, Rechtsform/Land/Telefon im Firmenprofil;
 *  - O-03.1/O-03.3 Firmenname im Cloud-Auftrag, sichtbarer Hinweis bei abgewiesener Firmenänderung;
 *  - O-04 eigener Zahlungstext bleibt, kein WhatsApp, Nummernkreisfehler sichtbar mit Wiederholung;
 *  - O-05.1/O-05.4 Mitglieder und unbestätigte Rollen bekommen keinen Assistenten;
 *  - EIN-14 die Sprachwahl im Assistenten gilt der Person, nicht dem Betrieb.
 *
 * Realer Stapel AuthProvider → BusinessStateGate → App; gestubbt sind nur die Supabase-RPC-Antworten (kein Netz).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { CloudBackupPendingBanner } from './components/system/CloudBackupPendingBanner';
import { SetupPage } from './pages/SetupPage';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import * as persistenceService from './services/persistenceService';
import { getCachedSetup } from './services/persistenceService';
import { getCompanyProfile } from './services/companyProfileService';
import { resetWorkspaceCloudBootstrapForTests } from './services/workspace/workspaceCloudBootstrapService';
import { resetSyncCoordinatorForTests } from './services/sync/syncCoordinator';
import { hydrateSyncOutbox, resetSyncOutboxForTests } from './services/sync/syncOutboxService';
import { validateCompanyProfileForSettings } from './services/setupValidationService';
import { SETUP_DRAFT_KEY_PREFIX } from './services/setupDraftService';
import { signOutUser } from './services/auth/supabaseAuthService';
import { createDefaultSetupWizardDraft } from './types/setup';
import type { SyncOutboxEntry } from './types/sync';
import { t } from './i18n';
import { resetTestStores } from './test/resetStores';
import { clearMockRpcHandlers, getMockProfile, registerMockRpcHandler } from './test/mockProfileStore';
import { login, loginAsDefaultAdmin, registerAndApproveUser } from './test/authFixtures';
import { getMockCurrentSession } from './test/mockSupabaseAuth';
import { alsInhaber, alsMitglied } from './test/workspaceRoleTestUtils';

const ARBEITGEBER_WS = 'ws-arbeitgeber';
const ARBEITGEBER_INHABER = 'inhaber-arbeitgeber';
const STAMP = '2026-10-23T08:00:00.000Z';

type Rolle = 'owner' | 'member';
type Upsert = { workspaceId: string; entity: string; payload: Record<string, unknown> };

/** Ein Server, der sich an seine eigenen Schreibvorgänge erinnert (wie setupCloudPersist01, 01D). */
const server = {
  rolle: 'owner' as Rolle,
  angelegt: new Set<string>(),
  zeilen: new Map<string, Record<string, unknown>>(),
  upserts: [] as Upsert[],
  nummernstart: [] as Array<Record<string, unknown>>,
  nummernstartAntwort: (args: Record<string, unknown>): unknown => ({
    applied: true,
    year: args.p_year,
    last_sequence: args.p_last_sequence,
  }),
  pullScheitert: false,
};

function aktuellesKonto(): string {
  return getMockCurrentSession()?.user.id ?? '';
}

function betriebVon(konto: string): string {
  return server.rolle === 'member' ? ARBEITGEBER_WS : `ws-${konto}`;
}

function betriebsZeile(konto: string) {
  return {
    id: betriebVon(konto),
    name: 'Mein Workspace',
    owner_user_id: server.rolle === 'member' ? ARBEITGEBER_INHABER : konto,
    created_at: STAMP,
    updated_at: STAMP,
    version: 1,
  };
}

function mitgliedsZeile(workspaceId: string, konto: string, rolle: Rolle) {
  return { workspace_id: workspaceId, user_id: konto, role: rolle, status: 'active', created_at: STAMP, updated_at: STAMP };
}

function registerHandlers(): void {
  registerMockRpcHandler('ensure_personal_workspace', () => {
    const konto = aktuellesKonto();
    const neu = server.rolle === 'owner' && !server.angelegt.has(konto);
    server.angelegt.add(konto);
    return { workspace: betriebsZeile(konto), member: mitgliedsZeile(betriebVon(konto), konto, server.rolle), created: neu };
  });
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    if (server.pullScheitert) throw new Error('Failed to fetch');
    const konto = aktuellesKonto();
    const ws = betriebVon(konto);
    const zeile = (entity: string) => {
      const payload = server.zeilen.get(`${ws}:${entity}`);
      return payload ? { workspace_id: ws, payload, row_version: 1, updated_at: STAMP } : null;
    };
    const members =
      server.rolle === 'member'
        ? [mitgliedsZeile(ws, ARBEITGEBER_INHABER, 'owner'), mitgliedsZeile(ws, konto, 'member')]
        : [mitgliedsZeile(ws, konto, 'owner')];
    return {
      workspace: betriebsZeile(konto),
      members,
      settings: null,
      vorgaenge: [],
      setup: zeile('company_setup'),
      company_profile: zeile('company_profile'),
    };
  });
  registerMockRpcHandler('pull_workspace_invoices', () => []);
  registerMockRpcHandler('pull_workspace_order_amendments', () => []);
  registerMockRpcHandler('upsert_workspace_sync_entity', (args) => {
    const entity = String(args.p_entity_type ?? '');
    const workspaceId = String(args.p_workspace_id ?? '');
    const outer = (args.p_payload ?? {}) as { payload?: Record<string, unknown> };
    const payload = outer.payload ?? (outer as Record<string, unknown>);
    server.upserts.push({ workspaceId, entity, payload });
    if (server.rolle === 'member') throw new Error('Keine Schreibberechtigung');
    server.zeilen.set(`${workspaceId}:${entity}`, args.p_payload as Record<string, unknown>);
    return { row_version: 1, payload: args.p_payload };
  });
  registerMockRpcHandler('set_workspace_invoice_number_start', (args) => {
    server.nummernstart.push({ ...args });
    return server.nummernstartAntwort(args);
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountApp(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <BusinessStateGate>
            <App />
          </BusinessStateGate>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  return host;
}

async function unmountApp(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
}

/** Tab schließen und neu öffnen: Speicher bleibt, Laufzeitzustand beginnt neu. */
async function neuOeffnen(): Promise<HTMLDivElement> {
  await unmountApp();
  resetTestStores();
  resetWorkspaceCloudBootstrapForTests();
  resetSyncCoordinatorForTests();
  return mountApp();
}

function q(container: ParentNode, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function feld(container: ParentNode, testId: string): HTMLInputElement {
  const node = q(container, testId);
  expect(node, `Feld ${testId} fehlt`).not.toBeNull();
  return node as HTMLInputElement;
}

async function eingeben(container: ParentNode, testId: string, value: string): Promise<void> {
  const element = feld(container, testId);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function klick(container: ParentNode, testId: string): Promise<void> {
  const element = q(container, testId) as HTMLButtonElement | null;
  expect(element, `Schaltfläche ${testId} fehlt`).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** Schritt 1 und 2 ausfüllen; danach steht der Assistent auf Schritt 3 (Bank). */
async function bisSchritt3(container: ParentNode): Promise<void> {
  await eingeben(container, 'setup-companyName', 'Irmak Haustechnik');
  await eingeben(container, 'setup-legalForm', 'GmbH');
  await eingeben(container, 'setup-street', 'Hauptstraße 1');
  await eingeben(container, 'setup-zip', '80331');
  await eingeben(container, 'setup-city', 'München');
  await eingeben(container, 'setup-country', 'Österreich');
  await eingeben(container, 'setup-phone', '+43 1 2345');
  await klick(container, 'setup-next');
  await eingeben(container, 'setup-taxNumber', '123/456/78901');
  await klick(container, 'setup-next');
  expect(q(container, 'setup-iban'), 'Schritt 3 nicht erreicht').not.toBeNull();
}

/** Ab Schritt 3 bis zum Abschluss. */
async function abSchritt3Abschliessen(container: ParentNode, letzteNummer = '12'): Promise<void> {
  await eingeben(container, 'setup-iban', 'DE89370400440532013000');
  await klick(container, 'setup-next');
  await eingeben(container, 'setup-lastInvoiceNumber', letzteNummer);
  await klick(container, 'setup-next');
  await klick(container, 'setup-next');
}

const firmenAuftraege = () =>
  server.upserts.filter((call) => call.entity === 'company_setup' || call.entity === 'company_profile');
const entwurfsSchluessel = () => Object.keys(localStorage).filter((key) => key.startsWith(SETUP_DRAFT_KEY_PREFIX));

describe('EINRICHTUNG-01 AP3 — Einrichtungsassistent (Katalog V3, O)', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    server.rolle = 'owner';
    server.angelegt.clear();
    server.zeilen.clear();
    server.upserts.length = 0;
    server.nummernstart.length = 0;
    server.nummernstartAntwort = (args) => ({ applied: true, year: args.p_year, last_sequence: args.p_last_sequence });
    server.pullScheitert = false;
    clearMockRpcHandlers();
    registerHandlers();
    resetSyncOutboxForTests();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    await loginAsDefaultAdmin();
    localStorage.clear();
  });

  afterEach(async () => {
    await unmountApp();
    vi.restoreAllMocks();
    clearMockRpcHandlers();
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    localStorage.clear();
  });

  it('O-02.1: die Angaben aus der Registrierung stehen im Assistenten', async () => {
    const container = await mountApp();
    expect(q(container, 'first-run-wizard'), 'Assistent fehlt').not.toBeNull();
    expect(feld(container, 'setup-companyName').value).toBe('OfficePilot Admin');
    expect(feld(container, 'setup-contactPerson').value).toBe('System Administrator');
    expect(feld(container, 'setup-email').value).toBe('admin@officepilot.local');
  });

  it('O-01.1: Tab schließen und neu öffnen — weiter bei Schritt 3 mit allen Eingaben', async () => {
    let container = await mountApp();
    await bisSchritt3(container);
    expect(entwurfsSchluessel()).toHaveLength(1);

    container = await neuOeffnen();
    // Ein Entwurf genau dieses Kontos und Betriebs: keine Rückfrage „kein abgeschlossener Betrieb“.
    expect(q(container, 'workspace-setup-not-found')).toBeNull();
    expect(q(container, 'first-run-wizard'), 'Assistent nicht fortgesetzt').not.toBeNull();
    expect(q(container, 'setup-draft-resumed')).not.toBeNull();
    expect(q(container, 'setup-progress')?.textContent).toContain('3');
    expect(q(container, 'setup-iban'), 'nicht bei Schritt 3').not.toBeNull();

    await klick(container, 'setup-back');
    expect(feld(container, 'setup-taxNumber').value).toBe('123/456/78901');
    await klick(container, 'setup-back');
    expect(feld(container, 'setup-companyName').value).toBe('Irmak Haustechnik');
    expect(feld(container, 'setup-legalForm').value).toBe('GmbH');
    expect(feld(container, 'setup-street').value).toBe('Hauptstraße 1');
    expect(feld(container, 'setup-country').value).toBe('Österreich');
    expect(feld(container, 'setup-phone').value).toBe('+43 1 2345');
  });

  it('O-01.2: ein anderes Konto auf demselben Gerät sieht den Entwurf nicht', async () => {
    const container = await mountApp();
    await bisSchritt3(container);
    await unmountApp();

    const b = await registerAndApproveUser('konto-b@einrichtung.test');
    await signOutUser();
    await login('konto-b@einrichtung.test', 'TestPasswort1');
    expect(aktuellesKonto()).toBe(b.id);
    resetTestStores();
    resetWorkspaceCloudBootstrapForTests();
    resetSyncCoordinatorForTests();
    const zweiter = await mountApp();

    expect(q(zweiter, 'first-run-wizard'), 'Assistent für Konto B fehlt').not.toBeNull();
    expect(q(zweiter, 'setup-draft-resumed')).toBeNull();
    expect(q(zweiter, 'setup-progress')?.textContent).toContain('1');
    expect(feld(zweiter, 'setup-companyName').value).toBe('Test Firma GmbH');
    expect(feld(zweiter, 'setup-companyName').value).not.toBe('Irmak Haustechnik');
    expect(zweiter.textContent ?? '').not.toContain('Irmak Haustechnik');
    // Der Entwurf von A bleibt für A erhalten.
    expect(entwurfsSchluessel().some((key) => key.includes(b.id))).toBe(false);
    expect(entwurfsSchluessel().length).toBeGreaterThanOrEqual(1);
  });

  it('O-01.3: Speicherfehler beim Abschluss — Hinweis, Entwurf bleibt, kein vorgetäuschter Abschluss', async () => {
    const container = await mountApp();
    await bisSchritt3(container);
    const original = persistenceService.persistAll;
    vi.spyOn(persistenceService, 'persistAll').mockImplementation((setup) => {
      if (setup?.setupComplete) {
        // Wie der echte Weg: das Setup wird übernommen, das Schreiben scheitert.
        persistenceService.setCachedSetup(setup);
        return { success: false };
      }
      return original(setup);
    });

    await abSchritt3Abschliessen(container);

    expect(q(container, 'setup-form-error')?.textContent).toContain(t('persist.banner.message', 'de'));
    expect(q(container, 'first-run-wizard'), 'Assistent verlassen').not.toBeNull();
    expect(container.textContent ?? '').not.toContain(t('setup.completed', 'de'));
    expect(getCachedSetup().setupComplete, 'Abschluss im Speicher vorgetäuscht').toBe(false);
    expect(entwurfsSchluessel(), 'Entwurf verloren').toHaveLength(1);
  });

  it('O-02.2 / O-03.1: Rechtsform, Land und Telefon im Firmenprofil; der Cloud-Auftrag trägt den Firmennamen', async () => {
    const container = await mountApp();
    await bisSchritt3(container);
    await abSchritt3Abschliessen(container);

    expect(q(container, 'first-run-wizard'), 'Assistent nicht abgeschlossen').toBeNull();
    const profile = getCompanyProfile();
    expect(profile.legalForm).toBe('GmbH');
    expect(profile.country).toBe('Österreich');
    expect(profile.phone).toBe('+43 1 2345');
    const profilAuftrag = server.upserts.filter((call) => call.entity === 'company_profile').at(-1);
    expect(profilAuftrag?.payload.companyName, 'Firmenname nicht in der Cloud').toBe('Irmak Haustechnik');
    expect(profilAuftrag?.payload.legalForm).toBe('GmbH');
    // O-01 — nach dem Abschluss kein Entwurf mehr.
    expect(entwurfsSchluessel()).toEqual([]);
  });

  it('O-04.1: ein eigener Zahlungstext bleibt beim Ändern des Zahlungsziels; ein Standardsatz folgt', async () => {
    const container = await mountApp();
    await bisSchritt3(container);
    await eingeben(container, 'setup-iban', 'DE89370400440532013000');
    await klick(container, 'setup-next');

    expect(feld(container, 'setup-paymentTerms').value).toBe('Zahlbar innerhalb von 14 Tagen ohne Abzug.');
    await eingeben(container, 'setup-paymentDays', '30');
    expect(feld(container, 'setup-paymentTerms').value).toBe('Zahlbar innerhalb von 30 Tagen ohne Abzug.');

    const eigener = 'Zahlbar sofort nach Erhalt, bitte mit Rechnungsnummer.';
    await eingeben(container, 'setup-paymentTerms', eigener);
    await eingeben(container, 'setup-paymentDays', '21');
    expect(feld(container, 'setup-paymentTerms').value).toBe(eigener);

    // Die Prüfung „Skontofrist ≤ Zahlungsziel“ bleibt unverändert wirksam.
    const pruefung = validateCompanyProfileForSettings({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Irmak Haustechnik',
      contactPerson: 'S. Irmak',
      street: 'Hauptstraße 1',
      zip: '80331',
      city: 'München',
      email: 'info@irmak.example',
      taxNumber: '123/456/78901',
      iban: 'DE89370400440532013000',
      defaultPaymentDays: 21,
      defaultPaymentTerms: eigener,
      skontoEnabled: true,
      skontoPercent: 2,
      skontoDays: 30,
    });
    expect(pruefung.errors.skontoDays).toBe('companyProfile.skontoDaysExceedPaymentDays');
  });

  it('O-04.2: WhatsApp wird nicht angeboten; ein Altwert beginnt mit E-Mail', async () => {
    const container = await mountApp();
    await bisSchritt3(container);
    await eingeben(container, 'setup-iban', 'DE89370400440532013000');
    await klick(container, 'setup-next');
    await klick(container, 'setup-next');

    expect(q(container, 'setup-channel-email')).not.toBeNull();
    expect(q(container, 'setup-channel-letter')).not.toBeNull();
    expect(q(container, 'setup-channel-whatsapp')).toBeNull();
    expect(createDefaultSetupWizardDraft({ ...DEFAULT_SETUP, communicationChannel: 'whatsapp' }).communicationChannel).toBe(
      'email',
    );
  });

  it('O-04.3: Fehler beim Nummernkreis — sichtbar, kein Setup-Erfolg, Wiederholung gelingt', async () => {
    server.nummernstartAntwort = () => {
      throw new Error('Failed to fetch');
    };
    const container = await mountApp();
    await bisSchritt3(container);
    await abSchritt3Abschliessen(container, '12');

    expect(server.nummernstart).toHaveLength(1);
    expect(server.nummernstart[0]).toMatchObject({ p_last_sequence: 12 });
    expect(q(container, 'setup-form-error')?.textContent).toContain(t('setupFlow.numberRange.network', 'de'));
    expect(q(container, 'first-run-wizard'), 'Assistent trotz Fehler verlassen').not.toBeNull();
    expect(getCachedSetup().setupComplete).toBe(false);
    expect(firmenAuftraege(), 'Firmendaten trotz Fehler gesendet').toEqual([]);
    expect(entwurfsSchluessel()).toHaveLength(1);

    // Ein unbekannter Serverfehler ist ebenso sichtbar.
    server.nummernstartAntwort = () => {
      throw new Error('etwas Unerwartetes');
    };
    await klick(container, 'setup-retry');
    expect(q(container, 'setup-form-error')?.textContent).toContain(t('setupFlow.numberRange.failed', 'de'));
    expect(getCachedSetup().setupComplete).toBe(false);

    server.nummernstartAntwort = (args) => ({ applied: true, year: args.p_year, last_sequence: args.p_last_sequence });
    await klick(container, 'setup-retry');
    expect(server.nummernstart).toHaveLength(3);
    expect(q(container, 'first-run-wizard'), 'Wiederholung schließt nicht ab').toBeNull();
    expect(getCachedSetup().setupComplete).toBe(true);
    expect(entwurfsSchluessel()).toEqual([]);
  });

  it('EIN-14: die Sprachwahl im Assistenten gilt der Person; der Betrieb behält seine Sprache', async () => {
    const container = await mountApp();
    const konto = aktuellesKonto();
    const tuerkisch = Array.from(container.querySelectorAll<HTMLButtonElement>('.setup-lang-chip')).find((chip) =>
      chip.textContent?.includes('TR'),
    );
    expect(tuerkisch, 'Sprachwahl fehlt').toBeDefined();
    await act(async () => {
      tuerkisch!.click();
    });
    await settle();

    expect(localStorage.getItem(`officetakt-ui-language:${konto}`)).toBe('tr');
    expect(getMockProfile(konto)?.ui_language).toBe('tr');
    expect(document.documentElement.lang).toBe('tr');

    await bisSchritt3(container);
    await abSchritt3Abschliessen(container);
    expect(getCachedSetup().setupComplete).toBe(true);
    expect(getCachedSetup().language, 'Sprache des Betriebs überschrieben').toBe('de');
    const setupAuftrag = server.upserts.filter((call) => call.entity === 'company_setup').at(-1);
    expect(setupAuftrag?.payload.language).toBe('de');
  });

  it('O-05.1: ein Mitglied im nicht eingerichteten Betrieb liest den Hinweis, ohne „Einrichtung fortsetzen“', async () => {
    server.rolle = 'member';
    const container = await mountApp();

    expect(q(container, 'workspace-setup-not-found')).not.toBeNull();
    expect(q(container, 'workspace-setup-member-hint')).not.toBeNull();
    expect(q(container, 'workspace-setup-blocked')?.getAttribute('data-access')).toBe('member');
    expect(q(container, 'workspace-setup-continue')).toBeNull();
    expect(q(container, 'first-run-wizard')).toBeNull();
    expect(container.textContent ?? '').toContain(t('setupFlow.member.hint', 'de'));
    expect(server.upserts).toEqual([]);
  });

  it('O-05.1 (Gegenprobe): der Inhaber desselben Zustands bekommt „Einrichtung fortsetzen“', async () => {
    // Bestehender Betrieb ohne Setup, kein Entwurf: die Rückfrage bleibt, mit Fortsetzen.
    server.angelegt.add(aktuellesKonto());
    const container = await mountApp();
    expect(q(container, 'workspace-setup-continue')).not.toBeNull();
    expect(q(container, 'workspace-setup-member-hint')).toBeNull();
    await klick(container, 'workspace-setup-continue');
    expect(q(container, 'first-run-wizard')).not.toBeNull();
  });

  it('O-05.4: ohne Cloud-Antwort bleibt der Assistent für ein Mitglied gesperrt', async () => {
    server.rolle = 'member';
    server.pullScheitert = true;
    const container = await mountApp();
    expect(q(container, 'workspace-restore-failure')).not.toBeNull();
    expect(q(container, 'first-run-wizard')).toBeNull();
    expect(q(container, 'workspace-setup-continue')).toBeNull();
  });
});

describe('EINRICHTUNG-01 AP3 — Einrichtungsseite ohne Rollenbestätigung (O-05.4)', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  async function renderSetupPage(): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const rootNode = createRoot(container);
    await act(async () => {
      rootNode.render(
        <MemoryRouter initialEntries={['/setup']}>
          <AuthProvider>
            <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: false }}>
              <Routes>
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/" element={<div data-testid="heute-page">Heute</div>} />
              </Routes>
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });
    await settle();
    mounted = { container, root: rootNode };
    return container;
  }

  beforeEach(async () => {
    localStorage.clear();
    await loginAsDefaultAdmin();
  });

  afterEach(async () => {
    if (mounted) {
      const current = mounted;
      await act(async () => current.root.unmount());
      current.container.remove();
      mounted = null;
    }
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('Mitglied: Hinweis statt Assistent', async () => {
    alsMitglied();
    const container = await renderSetupPage();
    expect(q(container, 'setup-blocked')?.getAttribute('data-access')).toBe('member');
    expect(q(container, 'setup-member-hint')).not.toBeNull();
    expect(q(container, 'first-run-wizard')).toBeNull();
  });

  it('unbekannte Rolle (keine Mitgliedschaft geladen): gesperrt, kein Rückfall auf Inhaber oder lokalen Betrieb', async () => {
    const container = await renderSetupPage();
    expect(q(container, 'setup-blocked')?.getAttribute('data-access')).toBe('unknown');
    expect(q(container, 'first-run-wizard')).toBeNull();
  });

  it('Gegenprobe Inhaber: der Assistent erscheint', async () => {
    alsInhaber();
    const container = await renderSetupPage();
    expect(q(container, 'first-run-wizard')).not.toBeNull();
    expect(q(container, 'setup-blocked')).toBeNull();
  });
});

describe('EINRICHTUNG-01 AP3 — abgewiesene Firmenänderung bleibt sichtbar (O-03.3)', () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  function eintrag(over: Partial<SyncOutboxEntry>): SyncOutboxEntry {
    return {
      id: `e-${over.sequence ?? 0}`,
      entityType: 'company_profile',
      entityId: 'ws-banner',
      operation: 'upsert',
      version: 1,
      queuedAt: STAMP,
      retryCount: 0,
      status: 'failed',
      lastErrorMessage: 'Firmenprofil ungueltig: companyName',
      ...over,
    } as SyncOutboxEntry;
  }

  async function renderBanner(): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const rootNode = createRoot(container);
    await act(async () => {
      rootNode.render(
        <MemoryRouter>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 }}>
            <CloudBackupPendingBanner />
          </AppProvider>
        </MemoryRouter>,
      );
    });
    mounted = { container, root: rootNode };
    return container;
  }

  afterEach(async () => {
    if (mounted) {
      const current = mounted;
      await act(async () => current.root.unmount());
      current.container.remove();
      mounted = null;
    }
    vi.restoreAllMocks();
    resetSyncOutboxForTests();
  });

  it('Inhaber: endgültig abgewiesene jüngste Änderung — Hinweis mit Weg zu den Firmendaten', async () => {
    alsInhaber();
    hydrateSyncOutbox([eintrag({ sequence: 2 }), eintrag({ id: 'alt', sequence: 1, status: 'completed' })]);
    const container = await renderBanner();
    expect(q(container, 'company-cloud-rejected-banner')).not.toBeNull();
    expect(q(container, 'company-cloud-rejected-open')?.getAttribute('href')).toBe('/einstellungen/firma');
  });

  it('eine spätere, angenommene Änderung löst den Hinweis', async () => {
    alsInhaber();
    hydrateSyncOutbox([eintrag({ sequence: 1 }), eintrag({ id: 'neu', sequence: 2, status: 'completed' })]);
    const container = await renderBanner();
    expect(q(container, 'company-cloud-rejected-banner')).toBeNull();
  });

  it('Mitglied: kein Hinweis (ändert keine Firmendaten)', async () => {
    alsMitglied();
    hydrateSyncOutbox([eintrag({ sequence: 2 })]);
    const container = await renderBanner();
    expect(q(container, 'company-cloud-rejected-banner')).toBeNull();
  });
});
