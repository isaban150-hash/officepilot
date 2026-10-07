/**
 * CLOUD-SYNC S5 Phase 2 — der Konflikt ist in **beiden** Rechnungseditoren
 * sichtbar und sperrt sichtbar.
 *
 * In der echten App ergab sich der Konflikt so: Gerät B bearbeitete offline
 * eine alte Fassung, Gerät A speicherte inzwischen; B kam zurück, der Server
 * wies B ab (`Versionskonflikt invoice_draft:3`), der Abzug vermerkte den
 * Konflikt. Hier wird genau dieser vermerkte Zustand in den Spiegel gelegt.
 *
 * Erwartet in beiden Editoren: Hinweis mit „Cloud-Fassung übernehmen" und
 * „Meine Fassung behalten", Eingabefelder sichtbar gesperrt, keine Freigabe.
 * Jede Entscheidung erst nach Bestätigung; danach ist die Sperre aufgehoben.
 *
 * Neutrale Beispieldaten.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { AppProvider } from '../context/AppContext';
import { RechnungPage } from './RechnungPage';
import { ManualInvoicePage } from './ManualInvoicePage';
import { createTestVorgangWithExecutedQuantity } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { createCustomer } from '../services/customerService';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { persistAll } from '../services/persistenceService';
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import { stripInvoiceDraftForCloud } from '../services/invoice/invoiceDraftCloudService';
import { getInvoiceDraftCloudEntity, putInvoiceDraftCloudEntity } from '../services/invoice/invoiceDraftCloudStore';
import { resetInvoiceDraftCloudBridgeForTests } from '../services/invoice/invoiceDraftCloudBridge';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import { resetInvoiceStore } from '../services/invoice/invoiceStore';
import { resetTestStores } from '../test/resetStores';
import type { InvoiceDraftLocator } from '../types/invoiceDraftDurability';
import type { InvoiceDraft } from '../types/models';

const WORKSPACE = 'ws-conflict-s5';
const VORGANG = 'vg-conflict-s5';

type Mount = { container: HTMLDivElement; root: Root };
const mounts: Mount[] = [];

async function render(entry: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, companyName: 'Beispiel Betrieb GmbH' }}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            <Route path="/rechnungen/neu" element={<ManualInvoicePage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  const mount = { container, root };
  mounts.push(mount);
  return mount;
}

async function waitFor(check: () => boolean, label: string, rounds = 160): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  throw new Error(`waitFor: ${label}`);
}

async function waitForStored(locator: InvoiceDraftLocator): Promise<{ draftId: string; draft: InvoiceDraft }> {
  for (let i = 0; i < 160; i += 1) {
    const loaded = await loadInvoiceDraftRecordByLocator(locator);
    if (loaded.ok) return { draftId: loaded.record.draftId, draft: loaded.draft };
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  throw new Error('kein gespeicherter Entwurf');
}

const q = <T extends HTMLElement = HTMLElement>(mount: Mount, testId: string) =>
  mount.container.querySelector<T>(`[data-testid="${testId}"]`);

async function click(mount: Mount, testId: string): Promise<void> {
  const element = q(mount, testId);
  if (!element) throw new Error(`fehlt: ${testId}`);
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

/** Der Zustand nach dem Abzug: B trägt seine Fassung (Version 2), die Cloud steht auf 3. */
async function konfliktVermerken(draft: InvoiceDraft, vorgangId: string | null, cloudEinleitung: string): Promise<void> {
  const core = stripInvoiceDraftForCloud(draft);
  await act(async () => {
    putInvoiceDraftCloudEntity({
      id: draft.id,
      vorgangId,
      invoiceType: draft.type,
      status: 'active',
      core,
      sync: { version: 2, deleted: false, updatedAt: '2026-10-06T21:00:00.000Z', deviceId: 'geraet-b', workspaceId: WORKSPACE },
      conflict: {
        kind: 'version',
        detectedAt: '2026-10-06T21:00:00.000Z',
        remote: { rowVersion: 3, status: 'active', deleted: false, core: { ...core, introText: cloudEinleitung } },
      },
    });
    persistAll();
    await Promise.resolve();
  });
}

/** Die vier Abschnitte des Detailformulars; ein gesperrtes fieldset sperrt im Browser alle Felder darin. */
function abschnitte(mount: Mount): { gesamt: number; gesperrt: number } {
  const alle = [...mount.container.querySelectorAll<HTMLFieldSetElement>('.invoice-edit fieldset.invoice-edit__section')];
  return { gesamt: alle.length, gesperrt: alle.filter((f) => f.hasAttribute('disabled')).length };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetTestStores();
  resetInvoiceDraftCloudBridgeForTests();
  resetInvoiceStore();
  hydrateCustomerStore([]);
  hydrateVorgangStore([createTestVorgangWithExecutedQuantity({ id: VORGANG, invoices: [] })]);
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

describe('S5 §7 — Konflikt in der Rechnung zum Auftrag', () => {
  it('Hinweis, sichtbare Sperre, keine Freigabe; „Cloud-Fassung übernehmen" lädt die Cloud-Fassung', async () => {
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');
    const mount = await render(`/vorgaenge/${VORGANG}/rechnung?type=abschlag`);
    await waitFor(() => q(mount, 'rechnung-page') !== null, 'Seite');
    const { draftId, draft } = await waitForStored({ sourceScopeKey: `workspace:${WORKSPACE}`, workspaceId: WORKSPACE, vorgangId: VORGANG, invoiceType: 'abschlag' });

    await konfliktVermerken(draft, VORGANG, 'Cloud-Fassung von Gerät A');
    await waitFor(() => q(mount, 'invoice-draft-cloud-conflict') !== null, 'Konflikthinweis');
    expect(q(mount, 'invoice-draft-cloud')?.getAttribute('data-conflict')).toBe('version');
    expect(q(mount, 'invoice-draft-cloud-takeCloud')).not.toBeNull();
    expect(q(mount, 'invoice-draft-cloud-keepMine')).not.toBeNull();
    // Während des Konflikts kein „Verwerfen" — erst entscheiden.
    expect(q(mount, 'invoice-draft-discard')).toBeNull();

    // Mengen sichtbar gesperrt.
    const mengen = [...mount.container.querySelectorAll<HTMLInputElement>('[data-testid^="invoice-qty-"]')];
    expect(mengen.length).toBeGreaterThan(0);
    expect(mengen.every((feld) => feld.disabled)).toBe(true);

    // Vorschau: keine Freigabe. Details: Felder sichtbar gesperrt.
    await click(mount, 'invoice-continue-preview');
    await waitFor(() => q(mount, 'invoice-approve') !== null, 'Vorschau');
    expect(q<HTMLButtonElement>(mount, 'invoice-approve')?.disabled).toBe(true);
    await click(mount, 'invoice-edit');
    await waitFor(() => q(mount, 'invoice-edit-intro') !== null, 'Details');
    expect(abschnitte(mount)).toEqual({ gesamt: 4, gesperrt: 4 });

    // Bewusste Entscheidung über den Produktweg — erst nach Bestätigung.
    await click(mount, 'invoice-draft-cloud-takeCloud');
    await waitFor(() => q(mount, 'invoice-draft-cloud-confirm-takeCloud') !== null, 'Bestätigung');
    await click(mount, 'invoice-draft-cloud-confirm-takeCloud');
    await waitFor(() => q(mount, 'invoice-draft-cloud-conflict') === null, 'Konflikt aufgelöst');

    const geladen = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: `workspace:${WORKSPACE}`, workspaceId: WORKSPACE, vorgangId: VORGANG, invoiceType: 'abschlag' });
    expect(geladen.ok && geladen.record.draftId).toBe(draftId);
    expect(geladen.ok && geladen.draft.introText).toBe('Cloud-Fassung von Gerät A');
    expect(getInvoiceDraftCloudEntity(draftId)).toMatchObject({ sync: { version: 3 }, core: { introText: 'Cloud-Fassung von Gerät A' } });
    expect(getInvoiceDraftCloudEntity(draftId)?.conflict).toBeUndefined();
    // Nach der Entscheidung ist der Entwurf wieder bearbeitbar.
    await waitFor(() => q(mount, 'invoice-edit-intro') !== null || q(mount, 'invoice-continue-preview') !== null, 'Editor wieder da');
    if (q(mount, 'invoice-edit-intro')) expect(abschnitte(mount).gesperrt).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('S5 §7 — Konflikt in der Rechnung ohne Auftrag', () => {
  it('Hinweis, sichtbare Sperre der Felder; „Meine Fassung behalten" hebt die Sperre bewusst auf', async () => {
    const created = createCustomer({ name: 'Muster Bau GmbH', street: 'Weg 1', zip: '33602', city: 'Bielefeld' });
    if (!created.success) throw new Error('kunde');
    const mount = await render('/rechnungen/neu');
    await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null, 'Kundenschritt');
    // Kunde gewählt: Ohne Konflikt wäre „Weiter“ (übernimmt den Kunden in den Entwurf) jetzt frei.
    const waehle = async (testId: string) => {
      const input = q(mount, testId)?.querySelector('input');
      if (!input) throw new Error('fehlt ' + testId);
      await act(async () => { input.click(); await Promise.resolve(); });
    };
    await waehle('customer-decision-existing');
    await waehle('customer-option-' + created.customer.id);
    await waitFor(() => q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled === false, 'Weiter frei');
    const { draftId, draft } = await waitForStored({ sourceScopeKey: `workspace:${WORKSPACE}`, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' });

    await konfliktVermerken({ ...draft, introText: 'Meine Fassung von Gerät B' }, null, 'Cloud-Fassung von Gerät A');
    await waitFor(() => q(mount, 'invoice-draft-cloud-conflict') !== null, 'Konflikthinweis');
    expect(q(mount, 'invoice-draft-cloud-takeCloud')).not.toBeNull();
    expect(q(mount, 'invoice-draft-cloud-keepMine')).not.toBeNull();
    // „Weiter“ würde den Entwurf ändern: gesperrt bis zur Entscheidung.
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled).toBe(true);

    await click(mount, 'invoice-draft-cloud-keepMine');
    await waitFor(() => q(mount, 'invoice-draft-cloud-confirm-keepMine') !== null, 'Bestätigung');
    await click(mount, 'invoice-draft-cloud-confirm-keepMine');
    await waitFor(() => q(mount, 'invoice-draft-cloud-conflict') === null, 'Konflikt aufgelöst');

    const entity = getInvoiceDraftCloudEntity(draftId)!;
    expect(entity.conflict).toBeUndefined();
    expect(entity.sync?.version, 'Schreibversuch gegen die zuletzt geladene Serverversion').toBe(3);
    await waitFor(() => q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled === false, 'Weiter wieder frei');
  });
});
