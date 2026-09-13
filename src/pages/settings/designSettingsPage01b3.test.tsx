/**
 * SETTINGS-01B3 — Design-Unterseite `/einstellungen/design`.
 *
 * Routing (Hub, kanonische Route, `#logo`-Alias ohne Loop), Logo-Flow
 * (Auswahl → Pending-Vorschau → Speichern lädt genau einmal hoch → Referenz,
 * Retry ohne zweiten Upload, Ersetzen, Entfernen behält historische Assets),
 * Vorlage (classic ohne Backfill, unbekannt fail-closed), Rollen und die
 * historische Sicherheit finalisierter Rechnungen. Bildarbeit über injizierte
 * Fakes (happy-dom hat weder Canvas noch createImageBitmap); Storage gemockt.
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
import { DesignSettingsPage, DESIGN_SETTINGS_ROUTE } from './DesignSettingsPage';
import { FirmendatenLegacyRoute } from './FirmendatenLegacyRoute';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as assetCloud from '../../services/branding/brandingAssetCloudService';
import * as resolver from '../../services/branding/brandingAssetResolver';
import * as syncClient from '../../services/sync/syncClientService';
import * as companyProfileService from '../../services/companyProfileService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { setBrandingLogoImageDepsForTests } from '../../services/branding/brandingLogoImageProcessing';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { resetUiSessionLiveState } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { buildInvoiceDraftForType, finalizeInvoiceDraft, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../../services/invoiceService';
import { getVorgangInvoice, hydrateVorgangStore, immutableInvoiceFingerprint } from '../../services/vorgangService';
import type { CompanyProfile, Vorgang } from '../../types/models';

const ADMIN_USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000b3b3';
const setup = { ...DEFAULT_SETUP, setupComplete: true };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const REFERENCE_OLD = { assetId: 'asset-alt', mimeType: 'image/png' as const };
const REFERENCE_NEW = { assetId: 'asset-neu', mimeType: 'image/png' as const };

const SAVED: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Design GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  iban: 'DE89370400440532013000',
};

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: ADMIN_USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

/** Bilddatei mit echter Signatur; die Abmessungen liefert der Fake-Dekoder. */
function pngFile(size = 64): File {
  const bytes = new Uint8Array(Math.max(size, PNG_SIGNATURE.length));
  bytes.set(PNG_SIGNATURE, 0);
  return new File([bytes], 'logo.png', { type: 'image/png' });
}

let decodedSize = { width: 400, height: 200 };
let root: Root;
let host: HTMLDivElement;
let upload: ReturnType<typeof vi.spyOn>;

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
        <Route path={DESIGN_SETTINGS_ROUTE} element={<DesignSettingsPage />} />
        <Route path="/firmendaten" element={<FirmendatenLegacyRoute />} />
        <Route path="/einstellungen/betrieb" element={<div data-testid="operating-settings-stub" />} />
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
async function selectFile(file: File): Promise<void> {
  const input = q('settings-design-logo-input') as HTMLInputElement;
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function click(id: string): Promise<void> {
  const button = q(id) as HTMLButtonElement;
  expect(button, id).not.toBeNull();
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}
function saveButton(): HTMLButtonElement {
  return q('settings-design-save') as HTMLButtonElement;
}

function seedVorgaenge(ids: string[]): void {
  hydrateVorgangStore(ids.map((id) => ({ ...createTestVorgang({ id, status: 'beauftragt', orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] }) as Vorgang));
}

function finalizeSampleInvoice(id: string) {
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
  const result = finalizeInvoiceDraft(id, draft, setup);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('finalize failed');
  return getVorgangInvoice(id, result.invoice.id)!;
}

describe('SETTINGS-01B3 — Design-Seite: Routing, Logo, Vorlage, Rollen, Historie', () => {
  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    localStorage.clear();
    setActiveStorageScope({ type: 'guest' });
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    hydrateCompanyProfileStore(SAVED);
    decodedSize = { width: 400, height: 200 };
    setBrandingLogoImageDepsForTests({
      decode: async () => ({ ...decodedSize, source: {} }),
      encode: async (_image, target, mimeType) => new Blob([new Uint8Array(Math.max(1, Math.floor((target.width * target.height) / 8)))], { type: mimeType }),
    });
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({ deviceId: 'device-1', workspaceId: WORKSPACE_ID, serverWorkspaceId: WORKSPACE_ID } as ReturnType<typeof syncClient.getSyncClient>);
    upload = vi.spyOn(assetCloud, 'uploadBrandingAsset').mockResolvedValue({ ok: true, reference: REFERENCE_NEW });
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({ ok: true, blob: new Blob([new Uint8Array(PNG_SIGNATURE)], { type: 'image/png' }) });
    await loginAsDefaultAdmin();
  });

  afterEach(async () => {
    await unmount();
    document.body.innerHTML = '';
    setBrandingLogoImageDepsForTests(null);
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
    vi.restoreAllMocks();
    resetTestStores();
  });

  /* ---------------- Routing (1–4) ---------------- */

  it('T1–T4: Hub-Eintrag, kanonische Route, #logo-Alias ohne Loop, andere Legacy-Hashes bleiben', async () => {
    await renderAt('/einstellungen');
    expect(q('settings-entry-logo')?.getAttribute('href')).toBe(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-group-design')?.textContent).toContain('Dokumente & Design');
    expect(q('settings-entry-logo')?.textContent).toContain('Logo und Darstellung');
    await unmount();

    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-page')).not.toBeNull();
    expect(q('settings-design-logo')).not.toBeNull();
    expect(q('settings-design-template')).not.toBeNull();
    expect(q('settings-design-preview')).not.toBeNull();
    expect(q('settings-design-back')?.getAttribute('href')).toBe('/einstellungen');
    await unmount();

    await renderAt('/firmendaten#logo');
    expect(pathNow()).toBe(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-page')).not.toBeNull();
    await settle();
    expect(pathNow()).toBe(DESIGN_SETTINGS_ROUTE);
    await unmount();

    // SETTINGS-01B5 — #datensicherung führt auf die Betriebsseite; nirgends mehr eine zweite Logo-UI.
    await renderAt('/firmendaten#datensicherung');
    expect(pathNow()).toBe('/einstellungen/betrieb');
    expect(host.querySelector('#profile-logo-file')).toBeNull();
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });

  /* ---------------- Logo (5–20) ---------------- */

  it('T5/T6: Leerzustand ohne Logo; vorhandenes Asset wird angezeigt', async () => {
    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-logo-none')).not.toBeNull();
    expect(q('settings-design-logo-remove')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(q('settings-design-logo-upload-label')?.textContent).toContain('hochladen');
    await unmount();

    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD } });
    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-logo-current')).not.toBeNull();
    expect(q('settings-design-logo-remove')).not.toBeNull();
    expect(q('settings-design-logo-upload-label')?.textContent).toContain('ersetzen');
    expect(resolver.resolveBrandingAsset).toHaveBeenCalledWith(WORKSPACE_ID, REFERENCE_OLD);
  });

  it('T7–T10: Auswahl erzeugt Pending-Vorschau ohne Upload/Profiländerung; Speichern lädt genau einmal hoch und speichert nur die Referenz', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(DESIGN_SETTINGS_ROUTE);
    decodedSize = { width: 4000, height: 3000 };
    await selectFile(pngFile(1000));

    expect(q('settings-design-logo-error')).toBeNull();
    expect(q('settings-design-logo-pending')).not.toBeNull();
    expect(q('settings-design-logo-pending-hint')?.textContent).toContain('4000×3000');
    expect(q('settings-design-logo-pending-hint')?.textContent).toContain('1600×1200');
    expect(upload).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(getCompanyProfile().branding).toBeUndefined();
    expect(saveButton().disabled).toBe(false);
    // Die Vorschau zeigt bereits das ausstehende Logo (Object-URL des Entwurfs).
    expect(q('invoice-header-logo')?.getAttribute('data-logo-kind')).toBe('legacy_data_url');

    await click('settings-design-save');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ workspaceId: WORKSPACE_ID, mimeType: 'image/png' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_NEW);
    expect(getCompanyProfile().logoDataUrl ?? '').toBe('');
    expect(saveButton().disabled).toBe(true);
    expect(q('settings-design-logo-pending')).toBeNull();
    expect(q('settings-design-logo-current')).not.toBeNull();
    expect(host.textContent).toContain('Design gespeichert.');
  });

  it('T11/T12: Ungültige Dateien (falsche Signatur, SVG, unlesbar) — verständliche Meldung, Logo bleibt', async () => {
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD } });
    await renderAt(DESIGN_SETTINGS_ROUTE);

    const wrong = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'x.png', { type: 'image/png' });
    await selectFile(wrong);
    expect(q('settings-design-logo-error')?.textContent).toBeTruthy();
    expect(q('settings-design-logo-current')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);

    await selectFile(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    expect(q('settings-design-logo-error')?.textContent).toBeTruthy();

    setBrandingLogoImageDepsForTests({ decode: async () => null, encode: async () => null });
    await selectFile(pngFile());
    expect(q('settings-design-logo-error')?.textContent).toContain('nicht gelesen');
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_OLD);
    expect(upload).not.toHaveBeenCalled();
    expect((q('settings-design-logo-input') as HTMLInputElement).getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');
  });

  it('T13/T14: Retry nach Profil-Fehler lädt nicht zweimal hoch; Upload-Fehler erlaubt erneuten Versuch', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    updateSpy.mockReturnValueOnce({ success: false, errorKey: 'companyProfile.error.companyName' } as ReturnType<typeof companyProfileService.updateCompanyProfile>);
    await renderAt(DESIGN_SETTINGS_ROUTE);
    await selectFile(pngFile());
    await click('settings-design-save');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(q('settings-design-logo-error')).not.toBeNull();
    expect(q('settings-design-logo-uploaded')).not.toBeNull();
    expect(saveButton().disabled).toBe(false);

    await click('settings-design-save');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_NEW);
    await unmount();

    // Upload-Fehler: bestehendes Logo bleibt, erneuter Versuch möglich.
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD } });
    upload.mockResolvedValueOnce({ ok: false, error: 'upload_failed' });
    await renderAt(DESIGN_SETTINGS_ROUTE);
    await selectFile(pngFile());
    await click('settings-design-save');
    expect(q('settings-design-logo-error')).not.toBeNull();
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_OLD);
    expect(q('settings-design-logo-pending')).not.toBeNull();
    await click('settings-design-save');
    expect(upload).toHaveBeenCalledTimes(3);
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_NEW);
  });

  it('T15/T16: Ersetzen setzt die neue Referenz; eine neue Auswahl verwirft eine Pending-Referenz', async () => {
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD, documentTemplate: 'classic' } });
    await renderAt(DESIGN_SETTINGS_ROUTE);
    await selectFile(pngFile());
    await click('settings-design-save');
    expect(getCompanyProfile().branding).toEqual({ logo: REFERENCE_NEW, documentTemplate: 'classic' });
    await unmount();

    vi.spyOn(companyProfileService, 'updateCompanyProfile').mockReturnValueOnce({ success: false, errorKey: 'companyProfile.error.companyName' } as ReturnType<typeof companyProfileService.updateCompanyProfile>);
    await renderAt(DESIGN_SETTINGS_ROUTE);
    await selectFile(pngFile());
    await click('settings-design-save');
    expect(q('settings-design-logo-uploaded')).not.toBeNull();
    await selectFile(pngFile(80));
    expect(q('settings-design-logo-uploaded')).toBeNull();
    expect(q('settings-design-logo-pending')).not.toBeNull();
  });

  it('T17–T20: Entfernen ist ausstehend bis Speichern, setzt {} und lässt historische Assets unberührt; „Behalten" hebt auf', async () => {
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD }, logoDataUrl: 'data:image/png;base64,QUJD' });
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(DESIGN_SETTINGS_ROUTE);

    await click('settings-design-logo-remove');
    expect(q('settings-design-logo-removed-hint')).not.toBeNull();
    expect(q('settings-design-logo-none')).not.toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
    expect(q('invoice-header-logo')).toBeNull();

    await click('settings-design-logo-keep');
    expect(q('settings-design-logo-removed-hint')).toBeNull();
    expect(q('settings-design-logo-current')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);

    await click('settings-design-logo-remove');
    await click('settings-design-save');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().branding).toEqual({});
    expect(getCompanyProfile().logoDataUrl ?? '').toBe('');
    expect(upload).not.toHaveBeenCalled();
    // Kein Storage-Löschen — historische Assets bleiben.
    expect((assetCloud as Record<string, unknown>).deleteBrandingAsset).toBeUndefined();
    expect(q('settings-design-logo-none')).not.toBeNull();
    expect(q('settings-design-logo-remove')).toBeNull();
  });

  /* ---------------- Vorlage (21–24) ---------------- */

  it('T21–T24: nur Classic sichtbar, Hinweis auf weitere Vorlagen, altes Profil ohne Backfill, kein primaryColor-Feld', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD } });
    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-template-classic')?.textContent).toContain('Standardvorlage');
    expect(host.querySelectorAll('[data-testid^="settings-design-template-"]').length).toBe(1);
    expect(q('settings-design-template')?.textContent).toContain('Weitere Vorlagen folgen');
    expect(q('settings-design-template')?.querySelector('select, input[type="radio"]')).toBeNull();
    expect(host.querySelector('input[type="color"]')).toBeNull();
    expect(host.textContent).not.toContain('Primärfarbe');
    // Anzeige mutiert nichts: kein Backfill von documentTemplate.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(getCompanyProfile().branding?.documentTemplate).toBeUndefined();

    await unmount();

    // Ein unbekannter Wert (neuere Version) wird fail-closed als classic angezeigt — ohne Mutation.
    hydrateCompanyProfileStore({ ...SAVED, branding: { documentTemplate: 'modern' as never } });
    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-template-classic')).not.toBeNull();
    expect(q('settings-design-template-modern')).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  /* ---------------- Rollen (32–33) ---------------- */

  it('T32/T33: owner/admin editierbar, member nur lesend mit Hinweis', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD } });
    seedWorkspace('member');
    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-readonly')?.textContent).toContain('Nur Administratoren');
    expect(q('settings-design-logo-input')).toBeNull();
    expect(q('settings-design-logo-remove')).toBeNull();
    expect(q('settings-design-save')).toBeNull();
    expect(q('settings-design-logo-current')).not.toBeNull();
    expect(q('settings-design-preview')).not.toBeNull();
    await unmount();

    seedWorkspace('admin');
    await renderAt(DESIGN_SETTINGS_ROUTE);
    expect(q('settings-design-readonly')).toBeNull();
    expect(q('settings-design-logo-input')).not.toBeNull();
    expect(q('settings-design-save')).not.toBeNull();
  });

  /* ---------------- Historische Sicherheit (34–36) ---------------- */

  it('T34–T36: finalisierte Rechnung behält ihr Logo; neue Rechnung nimmt das neue; Entfernen ändert alte Rechnung nicht', async () => {
    hydrateCompanyProfileStore({ ...SAVED, branding: { logo: REFERENCE_OLD } });
    seedVorgaenge(['v-alt', 'v-neu']);
    const oldInvoice = finalizeSampleInvoice('v-alt');
    const fingerprint = immutableInvoiceFingerprint(oldInvoice, 'v-alt');
    expect(oldInvoice.brandingSnapshot?.logo).toEqual(REFERENCE_OLD);

    await renderAt(DESIGN_SETTINGS_ROUTE);
    await selectFile(pngFile());
    await click('settings-design-save');
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_NEW);
    const afterReplace = getVorgangInvoice('v-alt', oldInvoice.id)!;
    expect(afterReplace.brandingSnapshot?.logo).toEqual(REFERENCE_OLD);
    expect(immutableInvoiceFingerprint(afterReplace, 'v-alt')).toBe(fingerprint);

    const newInvoice = finalizeSampleInvoice('v-neu');
    expect(newInvoice.brandingSnapshot?.logo).toEqual(REFERENCE_NEW);
    expect(newInvoice.brandingSnapshot?.documentTemplate).toBe('classic');

    await click('settings-design-logo-remove');
    await click('settings-design-save');
    expect(getCompanyProfile().branding).toEqual({});
    expect(getVorgangInvoice('v-alt', oldInvoice.id)!.brandingSnapshot?.logo).toEqual(REFERENCE_OLD);
    expect(getVorgangInvoice('v-neu', newInvoice.id)!.brandingSnapshot?.logo).toEqual(REFERENCE_NEW);
    expect(immutableInvoiceFingerprint(getVorgangInvoice('v-alt', oldInvoice.id)!, 'v-alt')).toBe(fingerprint);
  });

  /* ---------------- Vorschau auf der Seite (25–31) ---------------- */

  it('T25–T31: Vorschau ist ein echtes Dokument mit Firmenwerten, Beispielnummer und skaliertem Blatt — ohne Nebenwirkungen', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(DESIGN_SETTINGS_ROUTE);
    const sheet = q('settings-design-preview-sheet')!;
    expect(sheet.style.width).toBe('794px');
    expect(sheet.style.transform).toMatch(/^scale\(/);
    expect(sheet.querySelector('.invoice-document')).not.toBeNull();
    expect(sheet.textContent).toContain('Design GmbH');
    expect(sheet.textContent).toContain('VORSCHAU-0001');
    expect(sheet.textContent).toContain('Beispiel Kunde GmbH');
    expect(q('invoice-header-logo')).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(getVorgangInvoice('v-alt', 'x')).toBeUndefined();
  });
});
