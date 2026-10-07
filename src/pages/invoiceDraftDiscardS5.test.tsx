/**
 * CLOUD-SYNC S5 — „Entwurf verwerfen" im echten Editor (Rechnung ohne Auftrag).
 *
 * Gefunden in der echten App (Phase 1): Nach dem Verwerfen lud der Editor den
 * Slot neu und legte dabei sofort einen neuen, leeren Entwurf an, bevor er
 * verlassen wurde. Vertrag jetzt: confirm-first verwerfen, dann wird der
 * Editor verlassen — kein neuer Entwurf im Slot, kein Abgleich mehr, der
 * eigene Grabstein erscheint nie als „anderswo verworfen". Keine Rechnung wird
 * berührt. Geprüft ohne und mit freigegebener Cloud-Seite.
 *
 * Neutrale Beispieldaten.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { AppProvider } from '../context/AppContext';
import { ManualInvoicePage } from './ManualInvoicePage';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { hydrateVorgangStore } from '../services/vorgangService';
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import * as allowlist from '../services/sync/cloudSyncAllowlist';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import { getInvoiceDraftCloudSnapshot } from '../services/invoice/invoiceDraftCloudStore';
import { resetInvoiceDraftCloudBridgeForTests } from '../services/invoice/invoiceDraftCloudBridge';
import { getInvoiceStoreSnapshot, resetInvoiceStore } from '../services/invoice/invoiceStore';
import { resetTestStores } from '../test/resetStores';
import { disableInvoiceDraftCloudSyncForTests } from '../test/invoiceDraftCloudSwitch';
import type { InvoiceDraftLocator } from '../types/invoiceDraftDurability';

const WORKSPACE = 'ws-discard-s5';

type Mount = { container: HTMLDivElement; root: Root };
const mounts: Mount[] = [];

function locator(): InvoiceDraftLocator {
  return { sourceScopeKey: `workspace:${WORKSPACE}`, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} />;
}

async function renderPage(): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/rechnungen/neu']}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, companyName: 'Beispiel Betrieb GmbH' }}>
          <Routes>
            <Route path="/rechnungen/neu" element={<ManualInvoicePage />} />
            <Route path="/rechnungen/offen" element={<div data-testid="offen-stub" />} />
          </Routes>
          <LocationProbe />
        </AppProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  const mount = { container, root };
  mounts.push(mount);
  return mount;
}

async function waitFor(check: () => boolean, label: string, rounds = 120): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  throw new Error(`waitFor: ${label}`);
}

async function waitForStored(): Promise<string> {
  for (let i = 0; i < 120; i += 1) {
    const loaded = await loadInvoiceDraftRecordByLocator(locator());
    if (loaded.ok) return loaded.record.draftId;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  throw new Error('kein gespeicherter Entwurf');
}

const q = (mount: Mount, testId: string) => mount.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function click(mount: Mount, testId: string): Promise<void> {
  const element = q(mount, testId);
  if (!element) throw new Error(`fehlt: ${testId}`);
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetTestStores();
  resetInvoiceDraftCloudBridgeForTests();
  resetInvoiceStore();
  hydrateVorgangStore([]);
  hydrateCustomerStore([]);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH', street: 'Werkstraße 2', zip: '54321', city: 'Betriebsstadt', taxNumber: '11/222/33333' });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
});

afterEach(async () => {
  for (const mount of mounts.splice(0)) {
    await act(async () => mount.root.unmount());
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  await resetInvoiceDraftDurabilityDatabaseForTests();
  resetTestStores();
  resetInvoiceDraftCloudBridgeForTests();
});

describe('S5 — „Entwurf verwerfen" im Editor', () => {
  for (const cloud of [false, true]) {
    it(`verwirft nach Bestätigung, verlässt den Editor und legt keinen neuen Entwurf an (Cloud-Seite ${cloud ? 'freigegeben' : 'nicht freigegeben'})`, async () => {
      if (cloud) {
        vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
          (type) => type === 'invoice_draft' || allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
        );
      } else {
        disableInvoiceDraftCloudSyncForTests();
      }
      const finalize = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');
      const mount = await renderPage();
      await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null, 'Editor');
      const draftId = await waitForStored();
      await waitFor(() => q(mount, 'invoice-draft-discard') !== null, 'Verwerfen-Knopf');

      // confirm-first: Ohne Bestätigung passiert nichts.
      await click(mount, 'invoice-draft-discard');
      await waitFor(() => q(mount, 'invoice-draft-cloud-confirm') !== null, 'Dialog');
      // Der Dialog verspricht nur, was gilt: andere Geräte nur mit freigegebener Cloud-Seite.
      expect(q(mount, 'invoice-draft-cloud-confirm')?.textContent?.includes('anderen Geräten')).toBe(cloud);
      await click(mount, 'invoice-draft-cloud-confirm-cancel');
      expect((await loadInvoiceDraftRecordByLocator(locator())).ok, 'Abbrechen lässt den Entwurf stehen').toBe(true);

      await click(mount, 'invoice-draft-discard');
      await waitFor(() => q(mount, 'invoice-draft-cloud-confirm-discard') !== null, 'Bestätigen');
      await click(mount, 'invoice-draft-cloud-confirm-discard');
      await waitFor(() => q(mount, 'location')?.getAttribute('data-path') === '/rechnungen/offen', 'Editor verlassen');

      // Einige Runden Ruhe: Es entsteht nichts nach.
      for (let i = 0; i < 20; i += 1) {
        await act(async () => {
          await new Promise((done) => setTimeout(done, 10));
        });
      }
      const slot = await loadInvoiceDraftRecordByLocator(locator());
      expect(slot.ok, 'kein neuer Entwurf im Slot').toBe(false);

      const spiegel = getInvoiceDraftCloudSnapshot();
      expect(spiegel.map((entity) => entity.id), 'nur der verworfene Entwurf, kein neuer').toEqual([draftId]);
      expect(spiegel[0]?.sync?.deleted).toBe(true);
      expect(spiegel[0]?.conflict, 'der eigene Grabstein ist kein „anderswo verworfen"').toBeUndefined();

      // Keine Rechnung berührt, keine Freigabe.
      expect(finalize).not.toHaveBeenCalled();
      expect(getInvoiceStoreSnapshot()).toEqual([]);
    });
  }
});
