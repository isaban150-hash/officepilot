/**
 * SETTINGS-01B5 — Betriebsseite, vollständige Legacy-Hash-Migration,
 * taxFreeNotice auf der Rechnungsseite und die Ablösung der alten
 * Firmendaten-Seite (keine doppelte Logo-/Defaults-/Backup-UI mehr).
 * Synthetische Daten, kein Netz.
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
import { CompanySettingsPage } from './CompanySettingsPage';
import { DesignSettingsPage } from './DesignSettingsPage';
import { InvoiceSettingsPage } from './InvoiceSettingsPage';
import { OperatingSettingsPage, OPERATING_SETTINGS_ROUTE, OPERATING_SETTINGS_BACKUP_HREF } from './OperatingSettingsPage';
import { FirmendatenLegacyRoute, resolveFirmendatenLegacyTarget } from './FirmendatenLegacyRoute';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as companyProfileService from '../../services/companyProfileService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { getCachedSetup } from '../../services/persistenceService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { resetUiSessionLiveState } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { buildInvoiceDraftForType, buildManualInvoiceDraft, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../../services/invoiceService';
import { buildLegalNotices } from '../../services/invoiceTaxService';
import { findCriticalCompanyProfileDrift } from '../../services/invoice/companySnapshotDriftService';
import { getVorgangInvoice, hydrateVorgangStore, immutableInvoiceFingerprint } from '../../services/vorgangService';
import { SETTINGS_BACKUP_HREF } from '../../services/backupSectionNavigation';
import type { CompanyProfile, CompanySetup, Vorgang } from '../../types/models';

const ADMIN_USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000b5b5';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19', language: 'de' };
const CUSTOMER = { name: 'Beispiel Projektbau GmbH', contactPerson: '', street: 'Beispielweg 1', zip: '10000', city: 'Beispielstadt', email: '', phone: '' };

const SAVED: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Betrieb GmbH',
  contactPerson: 'A. Beispiel',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  email: 'info@example.invalid',
  taxNumber: '143/123/45678',
  iban: 'DE89370400440532013000',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  taxFreeNotice: '',
};

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: ADMIN_USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
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
        <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
        <Route path="/einstellungen/rechnungen" element={<InvoiceSettingsPage />} />
        <Route path="/einstellungen/design" element={<DesignSettingsPage />} />
        <Route path={OPERATING_SETTINGS_ROUTE} element={<OperatingSettingsPage />} />
        <Route path="/firmendaten" element={<FirmendatenLegacyRoute />} />
        <Route path="/synchronisation" element={<div data-testid="sync-stub" />} />
        <Route path="/admin/users" element={<div data-testid="admin-users-stub" />} />
        <Route path="/mehr" element={<div data-testid="mehr-stub" />} />
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

function q(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}
function pathNow(): string {
  return q('location')?.getAttribute('data-path') ?? '';
}
async function click(id: string): Promise<void> {
  const el = q(id) as HTMLElement;
  expect(el, id).not.toBeNull();
  await act(async () => {
    el.click();
  });
  await settle();
}
async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submitForm(): Promise<void> {
  const form = host.querySelector('form.settings-form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe('SETTINGS-01B5 — Betrieb, Legacy-Ablösung', () => {
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

  /* ---------------- Routing (1–9) ---------------- */

  it('T1/T2: /einstellungen/betrieb rendert die Betriebsseite; der Hub-Eintrag „Betrieb" führt dorthin', async () => {
    await renderAt('/einstellungen');
    expect(q('settings-entry-operations')?.getAttribute('href')).toBe(OPERATING_SETTINGS_ROUTE);
    expect(q('settings-entry-operations')?.textContent).toContain('Betrieb');
    // Endzustand des Hubs: genau vier Gruppen, keine Links auf /firmendaten oder /mehr.
    expect(host.querySelectorAll('.settings-group').length).toBe(4);
    for (const a of Array.from(host.querySelectorAll('.settings-row'))) {
      expect(a.getAttribute('href')?.startsWith('/firmendaten')).toBe(false);
      expect(a.getAttribute('href')).not.toBe('/mehr');
    }
    expect(host.textContent).not.toContain('Firmendaten');
    await click('settings-entry-operations');
    expect(pathNow()).toBe(OPERATING_SETTINGS_ROUTE);
    expect(q('settings-operating-page')).not.toBeNull();
    for (const section of ['language', 'backup', 'sync', 'admin']) {
      expect(q(`settings-operating-${section}`), section).not.toBeNull();
    }
    expect(q('settings-operating-back')?.getAttribute('href')).toBe('/einstellungen');
  });

  it('T3–T9: alle Legacy-Hashes landen am kanonischen Ziel, unbekannt → Firma, kein Loop', async () => {
    const cases: [string, string][] = [
      ['/firmendaten', '/einstellungen/firma'],
      ['/firmendaten#logo', '/einstellungen/design'],
      ['/firmendaten#zahlungsbedingungen', '/einstellungen/rechnungen'],
      ['/firmendaten#rechnungstexte', '/einstellungen/rechnungen'],
      ['/firmendaten#datensicherung', OPERATING_SETTINGS_ROUTE],
      ['/firmendaten#unbekannt', '/einstellungen/firma'],
    ];
    for (const [entry, expected] of cases) {
      await renderAt(entry);
      expect(pathNow(), entry).toBe(expected);
      await settle();
      expect(pathNow(), `${entry} loop`).toBe(expected);
      expect(host.querySelector('#profile-companyName'), entry).toBeNull();
      await unmount();
    }
    expect(resolveFirmendatenLegacyTarget('#datensicherung')).toBe(OPERATING_SETTINGS_BACKUP_HREF);
    expect(SETTINGS_BACKUP_HREF).toBe(OPERATING_SETTINGS_BACKUP_HREF);
  });

  /* ---------------- Betrieb (10–16) ---------------- */

  it('T10–T12: Sprache sichtbar mit bestehendem Wert; Wechsel wirkt sofort über CompanySetup.language (keine zweite Speicherung)', async () => {
    await renderAt(OPERATING_SETTINGS_ROUTE);
    const switcher = q('settings-operating-language-switcher')!;
    expect(switcher).not.toBeNull();
    expect(switcher.querySelector('[data-testid="language-option-de"]')?.className).toContain('chip--active');
    for (const code of ['de', 'tr', 'bg']) {
      expect(switcher.querySelector(`[data-testid="language-option-${code}"]`), code).not.toBeNull();
    }
    await act(async () => {
      (switcher.querySelector('[data-testid="language-option-tr"]') as HTMLButtonElement).click();
    });
    await settle();
    expect(getCachedSetup().language).toBe('tr');
    expect(host.textContent).toMatch(/Sprache gespeichert|Dil kaydedildi/);
    expect(host.textContent).toContain('Geçerli dil');
    // Kein eigener Speichern-Knopf auf der Betriebsseite.
    expect(q('settings-operating-save')).toBeNull();
    expect(host.querySelector('form.settings-form')).toBeNull();
  });

  it('T13/T14: Datensicherung ist erreichbar (Export + Wiederherstellung); Sync-Status und Link auf /synchronisation', async () => {
    await renderAt(OPERATING_SETTINGS_BACKUP_HREF);
    expect(q('backup-section')).not.toBeNull();
    expect(host.querySelector('#datensicherung')).not.toBeNull();
    expect(q('backup-export-panel')?.querySelector('button')).not.toBeNull();
    expect(q('backup-export-panel')?.querySelector('input[type="file"]')).not.toBeNull();
    expect(q('settings-operating-sync-status')?.textContent).toBeTruthy();
    expect(q('settings-operating-sync-last')).not.toBeNull();
    expect(q('settings-operating-sync-link')?.getAttribute('href')).toBe('/synchronisation');
    expect(q('settings-operating-sync-link')?.textContent).toContain('Synchronisation verwalten');
    await click('settings-operating-sync-link');
    expect(pathNow()).toBe('/synchronisation');
  });

  it('T15/T16: Benutzerverwaltung nur für Admin; member sieht Hinweis und keine Schreibmöglichkeit', async () => {
    await renderAt(OPERATING_SETTINGS_ROUTE);
    expect(q('settings-operating-users-link')?.getAttribute('href')).toBe('/admin/users');
    expect(q('settings-operating-more-link')?.getAttribute('href')).toBe('/mehr');
    await unmount();

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('member');
    await renderAt(OPERATING_SETTINGS_ROUTE);
    expect(q('settings-operating-role')?.textContent).toContain('Mitarbeiter');
    expect(q('settings-operating-role')?.textContent).toContain('Administratoren');
    expect(host.querySelector('form.settings-form')).toBeNull();
    expect(q('settings-operating-language-switcher')).not.toBeNull();
    await unmount();

    seedWorkspace('admin');
    await renderAt(OPERATING_SETTINGS_ROUTE);
    expect(q('settings-operating-role')?.textContent).toContain('kannst');
  });

  /* ---------------- taxFreeNotice (17–20) ---------------- */

  it('T17–T20: Hinweis bei steuerfreien Rechnungen auf der Rechnungsseite; Save; neuer Draft nutzt ihn; alter Draft und finalisierte Rechnung unverändert; kein Drift', async () => {
    hydrateVorgangStore([{ ...createTestVorgang({ id: 'v-tf', status: 'beauftragt', orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
    hydrateCompanyProfileStore({ ...SAVED, defaultTaxStatus: 'tax_free' });
    const before = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);
    expect(before.legalNotices).toEqual(['Die Leistung ist steuerfrei bzw. ohne Umsatzsteuer.']);
    const base = buildInvoiceDraftForType('v-tf', setup, 'rechnung')!;
    const finalized = finalizeInvoiceDraft('v-tf', updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true }), setup);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    const invoiceBefore = getVorgangInvoice('v-tf', finalized.invoice.id)!;
    const fingerprint = immutableInvoiceFingerprint(invoiceBefore, 'v-tf');

    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt('/einstellungen/rechnungen');
    expect(q('settings-invoices-section-tax')?.querySelector('[data-testid="settings-invoices-taxFreeNotice"]')).not.toBeNull();
    expect((q('settings-invoices-taxFreeNotice') as HTMLInputElement).value).toBe('');
    await type('settings-invoices-taxFreeNotice', 'Steuerfrei nach § 4 Nr. 1 UStG.');
    expect(q('settings-invoices-dirty')?.textContent).toBe('Ungespeicherte Änderungen');
    await submitForm();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().taxFreeNotice).toBe('Steuerfrei nach § 4 Nr. 1 UStG.');
    await unmount();
    await renderAt('/einstellungen/rechnungen');
    expect((q('settings-invoices-taxFreeNotice') as HTMLInputElement).value).toBe('Steuerfrei nach § 4 Nr. 1 UStG.');

    // Neuer Draft: bestehende Fachlogik (buildLegalNotices bei tax_free).
    const after = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);
    expect(after.legalNotices).toEqual(['Steuerfrei nach § 4 Nr. 1 UStG.']);
    expect(buildLegalNotices('tax_free', getCompanyProfile())).toEqual(['Steuerfrei nach § 4 Nr. 1 UStG.']);
    expect(buildLegalNotices('standard_19', getCompanyProfile())).toEqual([]);
    // Alter Draft und finalisierte Rechnung bleiben.
    expect(before.legalNotices).toEqual(['Die Leistung ist steuerfrei bzw. ohne Umsatzsteuer.']);
    const invoiceAfter = getVorgangInvoice('v-tf', finalized.invoice.id)!;
    expect(immutableInvoiceFingerprint(invoiceAfter, 'v-tf')).toBe(fingerprint);
    expect(invoiceAfter.legalNotices).toEqual(invoiceBefore.legalNotices);
    expect(findCriticalCompanyProfileDrift(invoiceAfter.companySnapshot!, getCompanyProfile())).toEqual([]);
  });

  /* ---------------- Legacy (21–26) ---------------- */

  it('T21–T24: nirgends mehr die alte Firmendaten-UI — keine doppelte Logo-, Defaults- oder Backup-Sektion', async () => {
    for (const route of ['/einstellungen', '/einstellungen/firma', '/einstellungen/rechnungen', '/einstellungen/design', OPERATING_SETTINGS_ROUTE]) {
      await renderAt(route);
      expect(host.querySelector('#profile-companyName'), route).toBeNull();
      expect(host.querySelector('#profile-logo-file'), route).toBeNull();
      expect(host.querySelector('#profile-payment-days'), route).toBeNull();
      expect(host.querySelectorAll('[data-testid="backup-section"]').length, route).toBe(route === OPERATING_SETTINGS_ROUTE ? 1 : 0);
      expect(host.querySelectorAll('input[type="file"]').length, route).toBe(route === '/einstellungen/design' ? 1 : route === OPERATING_SETTINGS_ROUTE ? 1 : 0);
      expect(host.querySelectorAll('[data-testid="settings-invoices-skontoEnabled"]').length, route).toBe(route === '/einstellungen/rechnungen' ? 1 : 0);
      expect(host.querySelectorAll('[data-testid="pilot-hints-panel"]').length, route).toBe(0);
      await unmount();
    }
  });
});
