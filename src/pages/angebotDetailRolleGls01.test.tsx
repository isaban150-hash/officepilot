import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { t } from '../i18n';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../services/companyProfileService';
import { resetDocuments } from '../services/documentService';
import * as offerArchive from '../services/offer/offerArchiveService';
import { finalizeOfferWithCloud } from '../services/offer/offerFinalizeCloudService';
import { addOfferDraft, getOfferById, resetOffers } from '../services/offer/offerService';
import { resetSyncChangeTrackerForTests } from '../services/sync/syncChangeTrackerService';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { hydrateSyncOutbox } from '../services/sync/syncOutboxService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../services/workspace/workspaceStore';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../test/mockProfileStore';
import { alsInhaber, alsMitglied } from '../test/workspaceRoleTestUtils';
import { AngebotDetailPage } from './AngebotDetailPage';

/*
 * GO-LIVE-SECURITY-01 — einen freigegebenen Angebotsstatus (versendet,
 * abgelehnt, storniert) setzen nur Inhaber und Admin; auch die Ablage, die den
 * Beleg ändert, ordnet nur deren Gerät zu. Ein Mitglied sieht den Beleg und das
 * PDF, aber keine Statusaktionen, und sein Gerät legt keine Ablage an.
 */

const WORKSPACE = '2e49b0a1-dbee-4649-aa4e-68064d52c8f5';

async function freigegebenesAngebot(): Promise<string> {
  const r = addOfferDraft(WORKSPACE, {
    customerId: 'cust-1',
    customer: { name: 'Muster Baustoffe GmbH', contactPerson: '', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld', email: 'kunde@example.invalid', phone: '' },
    title: 'Badsanierung EG',
    baustelle: 'Musterweg 1, Bielefeld',
    positions: [{ id: 'p1', description: 'Demontage', quantity: 4, unit: 'Stunden', unitPrice: 55 }],
    taxStatus: 'standard_19',
    offerDate: '2026-10-01',
    validUntil: '2026-12-31',
  } as never);
  if (!r.success) throw new Error('Entwurf fehlt');
  registerMockRpcHandler('finalize_workspace_offer', (args) => {
    const payload = {
      ...(args.p_payload as Record<string, unknown>),
      status: 'freigegeben',
      offerNumber: 'AN-2026-0001',
      offerSequenceNumber: 1,
      contentFingerprint: args.p_fingerprint,
      finalizedAt: '2026-10-01T10:00:00.000Z',
    };
    const row = {
      workspace_id: WORKSPACE,
      client_offer_id: String(args.p_offer_id),
      client_customer_id: 'cust-1',
      offer_number: 'AN-2026-0001',
      offer_sequence_number: 1,
      status: 'freigegeben',
      payload,
      row_version: 2,
      deleted: false,
      deleted_at: null,
      updated_at: '2026-10-01T10:00:00.000Z',
    };
    return { row, row_version: 2, replayed: false };
  });
  const fin = await finalizeOfferWithCloud(r.offer.id);
  if (!fin.ok) throw new Error(`Freigabe im Test fehlgeschlagen: ${JSON.stringify(fin)}`);
  expect(getOfferById(r.offer.id)?.status).toBe('freigegeben');
  return r.offer.id;
}

let container: HTMLDivElement;
let root: Root | null = null;

async function detail(offerId: string): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/angebote/${offerId}`] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(Routes, null, createElement(Route, { path: '/angebote/:offerId', element: createElement(AngebotDetailPage) })),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetOffers();
  resetDocuments();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  clearMockRpcHandlers();
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-09-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({ ...createCompanyProfileFromSetup(DEFAULT_SETUP), companyName: 'Beispiel Haustechnik GmbH' });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  clearMockRpcHandlers();
});

describe('GO-LIVE-SECURITY-01 — Angebotsdetail nach Rolle', () => {
  it('Mitglied: keine Statusaktionen, Rollenhinweis, keine Ablage vom Mitgliedsgerät', async () => {
    const id = await freigegebenesAngebot();
    alsMitglied();
    const ablage = vi.spyOn(offerArchive, 'ensureOfferArchived').mockResolvedValue({ ok: false, reason: 'pdf_failed' });
    await detail(id);

    expect(el('offer-detail-number')?.textContent).toContain('AN-2026-0001');
    expect(el('offer-pdf-view')).not.toBeNull();
    for (const a of ['versendet', 'abgelehnt', 'storniert']) expect(el(`offer-action-${a}`)).toBeNull();
    expect(el('offer-status-role-hint')?.textContent).toBe(t('offer.status.roleHint', 'de'));
    expect(el('offer-archive-pending')).toBeNull();
    expect(el('offer-archive-failed')).toBeNull();
    expect(ablage).not.toHaveBeenCalled();
  });

  it('Inhaber: Statusaktionen wie bisher, kein Rollenhinweis, Ablage wird zugeordnet', async () => {
    const id = await freigegebenesAngebot();
    alsInhaber();
    const ablage = vi.spyOn(offerArchive, 'ensureOfferArchived').mockResolvedValue({ ok: false, reason: 'pdf_failed' });
    await detail(id);

    for (const a of ['versendet', 'abgelehnt', 'storniert']) expect(el(`offer-action-${a}`)).not.toBeNull();
    expect(el('offer-status-role-hint')).toBeNull();
    expect(ablage).toHaveBeenCalledWith(id);
  });
});
