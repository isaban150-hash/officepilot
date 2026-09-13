/**
 * SETTINGS-01B2 — Settings-Hub, Routing, Zahnrad und Firmenprofil-Unterseite.
 *
 * Routing (Hub, kanonische Route, Alias, kein Loop, Benutzermenü, Zahnrad),
 * Formular (Laden, Bearbeiten, Speichern, accountHolder, Validierung, Dirty,
 * Resume, Save entfernt Resume, genau ein Profil-Update), Rollen
 * (owner/admin/member/unbekannt, Serverfehler), historische Sicherheit und
 * die Abgrenzung zu den Vorbelegungen. Synthetische Daten, kein Netz.
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
import { EinstellungenPage } from '../EinstellungenPage';
import { CompanySettingsPage, COMPANY_SETTINGS_EXCLUDED_FIELDS, COMPANY_SETTINGS_FIELDS } from './CompanySettingsPage';
import { FirmendatenLegacyRoute } from './FirmendatenLegacyRoute';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as companyProfileService from '../../services/companyProfileService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { captureAndPersistUiSession } from '../../services/uiSession/uiSessionCapture';
import { resetUiSessionLiveState, setPendingUiSessionApply } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot, loadUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { decideUiSessionRestore } from '../../services/uiSession/uiSessionRestore';
import { buildInvoiceDraftForType, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../../services/invoiceService';
import { getVorgangInvoice, hydrateVorgangStore, immutableInvoiceFingerprint } from '../../services/vorgangService';
import * as persistenceService from '../../services/persistenceService';
import type { CompanyProfile, Vorgang } from '../../types/models';

const ADMIN_USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000b2b2';
const ROUTE = '/einstellungen/firma';
const setup = { ...DEFAULT_SETUP, setupComplete: true };

const SAVED: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Bestand GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  country: 'Deutschland',
  contactPerson: 'A. Beispiel',
  email: 'info@example.invalid',
  taxNumber: '143/123/45678',
  bankName: 'Musterbank',
  iban: 'DE89370400440532013000',
  bic: 'MUSTDEFF',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultIntroText: 'Vorbelegter Einleitungstext',
};

function seedWorkspace(role: 'owner' | 'admin' | 'member' | 'none', ownerUserId = 'usr-owner'): void {
  hydrateWorkspaceStore({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Beispielbetrieb',
      ownerUserId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    },
    workspaceMembers:
      role === 'none'
        ? []
        : [{ workspaceId: WORKSPACE_ID, userId: ADMIN_USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

let root: Root;
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
        <Route path="/einstellungen" element={<EinstellungenPage />} />
        <Route path={ROUTE} element={<CompanySettingsPage />} />
        <Route path="/firmendaten" element={<FirmendatenLegacyRoute />} />
        <Route path="/einstellungen/rechnungen" element={<div data-testid="invoice-settings-stub" />} />
        <Route path="/einstellungen/betrieb" element={<div data-testid="operating-settings-stub" />} />
        <Route path="/mehr" element={<div data-testid="mehr-page-stub" />} />
        <Route path="/admin/users" element={<div data-testid="admin-users-stub" />} />
      </Route>
    </Routes>
  );
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
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
    root.render(
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
  if (root) await act(async () => root.unmount());
  host?.remove();
}

/** Der Neuaufbau derselben Route mit Schnappschuss aus dem Speicher (wie ein Reload). */
async function remount(): Promise<void> {
  await unmount();
  const decision = decideUiSessionRestore({ userId: null, currentPathname: ROUTE, currentSearch: '' });
  if (decision.intent === 'silent' && decision.snapshot) setPendingUiSessionApply(decision.snapshot);
  await renderAt(ROUTE);
}

function q(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}
function input(field: string): HTMLInputElement {
  return host.querySelector(`[data-testid="settings-company-${field}"]`) as HTMLInputElement;
}
async function type(field: string, value: string): Promise<void> {
  const el = input(field);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(): Promise<void> {
  const form = host.querySelector('form.settings-form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}
function pathNow(): string {
  return q('location')?.getAttribute('data-path') ?? '';
}

describe('SETTINGS-01B2 — Hub, Routing, Firmenprofil', () => {
  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    localStorage.clear();
    setActiveStorageScope({ type: 'guest' });
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    hydrateCompanyProfileStore(SAVED);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await loginAsDefaultAdmin();
  });

  afterEach(async () => {
    await unmount();
    document.body.innerHTML = '';
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
    vi.restoreAllMocks();
    resetTestStores();
  });

  /* ---------------- Routing ---------------- */

  it('R1: /einstellungen ist der Hub mit den vier Bereichen und Zeilen statt Karten', async () => {
    await renderAt('/einstellungen');
    expect(q('einstellungen-page')).not.toBeNull();
    for (const group of ['company', 'documents', 'design', 'team']) {
      expect(q(`settings-group-${group}`), group).not.toBeNull();
    }
    expect(q('settings-entry-company-profile')?.getAttribute('href')).toBe(ROUTE);
    expect(q('settings-entry-invoices')?.getAttribute('href')).toBe('/einstellungen/rechnungen'); // seit SETTINGS-01B4
    expect(q('settings-entry-logo')?.getAttribute('href')).toBe('/einstellungen/design'); // seit SETTINGS-01B3
    expect(host.querySelectorAll('.settings-row__icon').length).toBeGreaterThanOrEqual(5);
    expect(host.querySelectorAll('.mehr-link-card').length).toBe(0);
  });

  it('R2: /einstellungen/firma rendert die Firmenprofil-Seite mit den vorhandenen Daten', async () => {
    await renderAt(ROUTE);
    expect(q('settings-company-page')).not.toBeNull();
    expect(input('companyName').value).toBe('Bestand GmbH');
    expect(input('iban').value).toBe('DE89370400440532013000');
    expect(input('accountHolder').value).toBe('');
    for (const section of ['company', 'address', 'contact', 'tax', 'register', 'bank']) {
      expect(q(`settings-company-section-${section}`), section).not.toBeNull();
    }
  });

  it('R3/R4: /firmendaten ohne Hash ist ein Alias (replace) ohne Loop; mit Legacy-Hash bleibt die alte Seite', async () => {
    await renderAt('/firmendaten');
    expect(pathNow()).toBe(ROUTE);
    expect(q('settings-company-page')).not.toBeNull();
    await unmount();

    // Seit SETTINGS-01B4/01B5: jeder bekannte Hash hat ein kanonisches Ziel — die alte Seite wird nie gerendert.
    await renderAt('/firmendaten#zahlungsbedingungen');
    expect(pathNow()).toBe('/einstellungen/rechnungen');
    await unmount();

    await renderAt('/firmendaten#datensicherung');
    expect(pathNow()).toBe('/einstellungen/betrieb');
    expect(host.querySelector('.company-profile-form')).toBeNull();
    await unmount();

    // Seit SETTINGS-01B3: #logo führt auf die Design-Seite (siehe designSettingsPage01b3.test.tsx).
    await renderAt('/firmendaten#logo');
    expect(pathNow()).toBe('/einstellungen/design');
    await unmount();

    await renderAt('/firmendaten#unbekannt');
    expect(pathNow()).toBe(ROUTE);
  });

  it('R5/R6: Benutzermenü und Zahnrad führen zu den Einstellungen', async () => {
    await renderAt('/');
    const gear = q('settings-gear') as HTMLAnchorElement;
    expect(gear).not.toBeNull();
    expect(gear.getAttribute('href')).toBe('/einstellungen');
    expect(gear.getAttribute('aria-label')).toBe('Einstellungen öffnen');
    await act(async () => gear.click());
    await settle();
    expect(pathNow()).toBe('/einstellungen');
    expect(q('user-menu-einstellungen')?.getAttribute('href') ?? q('user-menu')).not.toBeNull();
    // Kein Sidebar-/Bottom-Nav-Eintrag für Einstellungen.
    expect(host.querySelectorAll('.bottom-nav a[href="/einstellungen"]').length).toBe(0);
    expect(host.querySelectorAll('.sidebar-nav a[href="/einstellungen"]').length).toBe(0);
  });

  /* ---------------- Formular ---------------- */

  it('F1–F4: Bearbeiten, Dirty, Speichern mit accountHolder — genau ein Profil-Update', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(ROUTE);
    const save = q('settings-company-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(q('settings-company-dirty')?.textContent).toBe('Keine Änderungen');

    await type('accountHolder', 'Bestand Haustechnik GmbH');
    await type('phone', '+49 5222 1');
    expect((q('settings-company-save') as HTMLButtonElement).disabled).toBe(false);
    expect(q('settings-company-dirty')?.textContent).toBe('Ungespeicherte Änderungen');

    await submit();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const profile = getCompanyProfile();
    expect(profile.accountHolder).toBe('Bestand Haustechnik GmbH');
    expect(profile.phone).toBe('+49 5222 1');
    expect(profile.defaultIntroText).toBe('Vorbelegter Einleitungstext');
    expect((q('settings-company-save') as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('Firmenprofil gespeichert.');
  });

  it('F5: Validierungsfehler stehen am Feld, nichts wird gespeichert', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(ROUTE);
    await type('email', 'keine-mail');
    await type('accountHolder', 'x'.repeat(121));
    await submit();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(q('settings-company-email-error')?.textContent).toBeTruthy();
    expect(q('settings-company-accountHolder-error')?.textContent).toContain('120');
    expect(getCompanyProfile().email).toBe('info@example.invalid');
    // Korrektur löscht den Feldfehler.
    await type('email', 'neu@example.invalid');
    expect(q('settings-company-email-error')).toBeNull();
  });

  it('F6/F7: Dirty-Entwurf überlebt den Neuaufbau; Speichern entfernt ihn', async () => {
    await renderAt(ROUTE);
    await type('companyName', 'Neuer Name GmbH');
    captureAndPersistUiSession({ pathname: ROUTE, search: '', hash: '', historyKey: 'k1', mainScrollTop: 0, userId: null, source: 'auto' });
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);

    await remount();
    expect(input('companyName').value).toBe('Neuer Name GmbH');
    expect(getCompanyProfile().companyName).toBe('Bestand GmbH');

    await submit();
    expect(getCompanyProfile().companyName).toBe('Neuer Name GmbH');
    captureAndPersistUiSession({ pathname: ROUTE, search: '', hash: '', historyKey: 'k2', mainScrollTop: 0, userId: null, source: 'auto' });
    expect(loadUiSessionSnapshot()?.drafts.dirty ?? false).toBe(false);
    await remount();
    expect(input('companyName').value).toBe('Neuer Name GmbH');
  });

  it('F8: ein neuer gespeicherter Stand überschreibt keine ungespeicherte Eingabe, ein veralteter Entwurf legt sich nicht darüber', async () => {
    await renderAt(ROUTE);
    await type('city', 'Neustadt');
    captureAndPersistUiSession({ pathname: ROUTE, search: '', hash: '', historyKey: 'k1', mainScrollTop: 0, userId: null, source: 'auto' });
    // Cloud-Pull ändert die Basis (anderes Gerät hat gespeichert).
    hydrateCompanyProfileStore({ ...SAVED, street: 'Andere Straße 9' });
    await remount();
    // Der alte Entwurf gehört zu einer anderen Basis und wird verworfen — nichts wird vermischt.
    expect(input('street').value).toBe('Andere Straße 9');
    expect(input('city').value).toBe('Betriebsstadt');
  });

  /* ---------------- Rollen ---------------- */

  it('P1–P3: owner/admin editierbar, member read-only, lokal ohne Cloud schreibbar', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('owner');
    expect(resolveWorkspaceWriteAccess({ userId: ADMIN_USER_ID, cloudConfigured: true })).toMatchObject({ canWrite: true, role: 'owner' });
    seedWorkspace('admin');
    expect(resolveWorkspaceWriteAccess({ userId: ADMIN_USER_ID, cloudConfigured: true })).toMatchObject({ canWrite: true, role: 'admin' });
    seedWorkspace('none', ADMIN_USER_ID);
    expect(resolveWorkspaceWriteAccess({ userId: ADMIN_USER_ID, cloudConfigured: true })).toMatchObject({ canWrite: true, role: 'owner' });
    seedWorkspace('none');
    expect(resolveWorkspaceWriteAccess({ userId: ADMIN_USER_ID, cloudConfigured: true })).toMatchObject({ canWrite: false, reason: 'membership_unknown' });
    expect(resolveWorkspaceWriteAccess({ userId: ADMIN_USER_ID, cloudConfigured: false })).toMatchObject({ canWrite: true, reason: 'local_only' });

    seedWorkspace('member');
    await renderAt(ROUTE);
    expect(q('settings-company-readonly')?.textContent).toContain('Nur Administratoren');
    expect(q('settings-company-save')).toBeNull();
    expect(input('companyName').readOnly).toBe(true);
    expect(input('companyName').value).toBe('Bestand GmbH');
    await unmount();

    seedWorkspace('admin');
    await renderAt(ROUTE);
    expect(q('settings-company-readonly')).toBeNull();
    expect(q('settings-company-save')).not.toBeNull();
    expect(input('companyName').readOnly).toBe(false);
  });

  it('P4: ein Persistenzfehler wird verständlich gemeldet, nicht technisch', async () => {
    vi.spyOn(persistenceService, 'getLastPersistSuccess').mockReturnValue(false);
    await renderAt(ROUTE);
    await type('bankName', 'Andere Bank');
    await submit();
    expect(host.textContent).not.toContain('persist.failed');
    expect(host.textContent).toMatch(/gespeichert|Speichern|Gerät/);
  });

  /* ---------------- Historische Sicherheit / Abgrenzung ---------------- */

  it('H1: Speichern verändert keine finalisierte Rechnung', async () => {
    hydrateVorgangStore([{ ...createTestVorgang({ id: 'v-b2', status: 'beauftragt', orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
    const base = buildInvoiceDraftForType('v-b2', setup, 'rechnung')!;
    const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
    const result = finalizeInvoiceDraft('v-b2', draft, setup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = getVorgangInvoice('v-b2', result.invoice.id)!;
    const fingerprint = immutableInvoiceFingerprint(before, 'v-b2');

    await renderAt(ROUTE);
    await type('companyName', 'Umbenannt GmbH');
    await type('iban', 'DE02120300000000202051');
    await submit();
    expect(getCompanyProfile().companyName).toBe('Umbenannt GmbH');
    const after = getVorgangInvoice('v-b2', result.invoice.id)!;
    expect(after.companySnapshot?.companyName).toBe('Bestand GmbH');
    expect(after.companySnapshot?.iban).toBe('DE89370400440532013000');
    expect(immutableInvoiceFingerprint(after, 'v-b2')).toBe(fingerprint);
  });

  it('H2: Vorbelegungen, Logo, Sprache und Backup gehören nicht auf die Firmenprofil-Seite', async () => {
    await renderAt(ROUTE);
    for (const field of COMPANY_SETTINGS_EXCLUDED_FIELDS) {
      expect(host.querySelector(`[name="${field}"]`), field).toBeNull();
      expect((COMPANY_SETTINGS_FIELDS as readonly string[]).includes(field)).toBe(false);
    }
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.textContent).not.toContain('Skonto');
    expect(host.textContent).not.toContain('Zahlungsziel');
    expect(host.textContent).not.toContain('Datensicherung');
    expect(host.textContent).not.toContain('Sprache');
    expect(host.querySelector('form.settings-form')?.getAttribute('novalidate')).not.toBeNull();
  });
});
