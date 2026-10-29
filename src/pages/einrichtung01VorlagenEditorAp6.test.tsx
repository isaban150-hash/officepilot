/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.21) — neue Dokumente übernehmen die Vorgaben des Betriebs, bestehende nicht.
 *
 *   V-01.1  neues Angebot: Gültigkeit (Tage), Einleitung, Schluss; ein bestehender Entwurf bleibt unverändert
 *   V-01.3  neuer Auftrag: Einleitung und Schluss
 *   V-05.1  neuer Auftrag: Steuerstatus aus dem Profil-Standard, nicht aus `DEFAULT_SETUP`
 *   V-01.4  neuer Brief: Anrede und Grußformel als Vorbelegung des Textes
 *
 * Synthetische Daten, kein Netz.
 */
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../context/AppContext';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../services/companyProfileService';
import { getBusinessDay } from '../services/businessDateService';
import { addOfferDraft, emptyCustomerBilling, normalizeOfferPosition, resetOffers } from '../services/offer/offerService';
import { buildLetterBodyTemplate } from '../services/letter/letterTemplate';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { resetSyncChangeTrackerForTests } from '../services/sync/syncChangeTrackerService';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { hydrateSyncOutbox } from '../services/sync/syncOutboxService';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../services/workspace/workspaceStore';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import { AngebotEditorPage } from './AngebotEditorPage';
import { AuftragEditorPage } from './AuftragEditorPage';
import { BriefEditorPage } from './BriefEditorPage';
import type { CompanyProfile } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-00000000a6e1';

let container: HTMLDivElement;
let root: Root | null = null;

const el = <T extends HTMLElement>(id: string) => container.querySelector(`[data-testid="${id}"]`) as T | null;

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstraße 5',
    zip: '33602',
    city: 'Bielefeld',
    ...overrides,
  };
}

function plusDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return getBusinessDay(date);
}

async function show(path: string, routePath: string, page: ComponentType, setup = DEFAULT_SETUP): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(AppProvider, { initialSetup: setup }, createElement(Routes, null, createElement(Route, { path: routePath, element: createElement(page) }))),
      ),
    );
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetOffers();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  hydrateCustomerStore([]);
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-09-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  alsInhaber();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe('EINRICHTUNG-01 (AP6; 1.21) — Vorgaben für neue Dokumente', { timeout: 30_000 }, () => {
  it('V-01.1: ein neues Angebot übernimmt Gültigkeit, Einleitung und Schluss', async () => {
    hydrateCompanyProfileStore(profile({ offerValidityDays: 14, offerIntroText: 'Gern bieten wir Ihnen an:', offerClosingText: 'Wir freuen uns auf Ihren Auftrag.' }));
    await show('/angebote/neu', '/angebote/neu', AngebotEditorPage);
    expect(el<HTMLInputElement>('offer-valid-until')?.value).toBe(plusDays(14));
    expect(el<HTMLTextAreaElement>('offer-intro')?.value).toBe('Gern bieten wir Ihnen an:');
    expect(el<HTMLTextAreaElement>('offer-closing')?.value).toBe('Wir freuen uns auf Ihren Auftrag.');
  });

  it('V-01.1: ohne Vorgabe gilt der Standard von 30 Tagen', async () => {
    hydrateCompanyProfileStore(profile());
    await show('/angebote/neu', '/angebote/neu', AngebotEditorPage);
    expect(el<HTMLInputElement>('offer-valid-until')?.value).toBe(plusDays(30));
    expect(el<HTMLTextAreaElement>('offer-intro')?.value).toBe('');
  });

  it('V-01.1 (Gegenprobe): ein bestehender Entwurf bleibt unverändert', async () => {
    hydrateCompanyProfileStore(profile());
    const draft = addOfferDraft(WORKSPACE, {
      customer: { ...emptyCustomerBilling(), name: 'Bestand Kunde' },
      title: 'Altes Angebot',
      positions: [normalizeOfferPosition({ description: 'Arbeit', quantity: 1, unitPrice: 10 })],
      taxStatus: 'standard_19',
      offerDate: '2026-10-01',
      validUntil: '2026-10-31',
      introText: 'Alte Einleitung',
      closingText: 'Alter Schluss',
    });
    if (!draft.success) throw new Error('Entwurf nicht angelegt');
    hydrateCompanyProfileStore(profile({ offerValidityDays: 14, offerIntroText: 'Neue Einleitung', offerClosingText: 'Neuer Schluss' }));
    await show(`/angebote/${draft.offer.id}/bearbeiten`, '/angebote/:offerId/bearbeiten', AngebotEditorPage);
    expect(el<HTMLInputElement>('offer-valid-until')?.value).toBe('2026-10-31');
    expect(el<HTMLTextAreaElement>('offer-intro')?.value).toBe('Alte Einleitung');
    expect(el<HTMLTextAreaElement>('offer-closing')?.value).toBe('Alter Schluss');
  });

  it('V-01.3/V-05.1: ein neuer Auftrag übernimmt Einleitung, Schluss und den Steuerstatus des Profils', async () => {
    hydrateCompanyProfileStore(profile({ orderIntroText: 'Vielen Dank für Ihren Auftrag.', orderClosingText: 'Mit freundlichen Grüßen', defaultTaxStatus: 'tax_free' }));
    await show('/auftraege/neu', '/auftraege/neu', AuftragEditorPage, { ...DEFAULT_SETUP, taxStatus: 'standard_19' });
    expect(el<HTMLTextAreaElement>('order-intro')?.value).toBe('Vielen Dank für Ihren Auftrag.');
    expect(el<HTMLTextAreaElement>('order-closing')?.value).toBe('Mit freundlichen Grüßen');
    expect(el<HTMLSelectElement>('order-tax-status')?.value).toBe('tax_free');
  });

  it('V-01.4: ein neuer Brief beginnt mit Anrede und Grußformel', async () => {
    const vorgaben = { letterSalutation: 'Sehr geehrte Damen und Herren,', letterClosing: 'Mit freundlichen Grüßen' };
    hydrateCompanyProfileStore(profile(vorgaben));
    await show('/schreiben/neu', '/schreiben/neu', BriefEditorPage);
    expect(el<HTMLTextAreaElement>('letter-body')?.value).toBe(buildLetterBodyTemplate(vorgaben));
    expect(buildLetterBodyTemplate(vorgaben)).toBe('Sehr geehrte Damen und Herren,\n\n\n\nMit freundlichen Grüßen');
    expect(buildLetterBodyTemplate({})).toBe('');
    expect(buildLetterBodyTemplate({ letterSalutation: 'Hallo,' })).toBe('Hallo,\n\n');
    expect(buildLetterBodyTemplate({ letterClosing: 'Gruß' })).toBe('\n\nGruß');
  });
});
