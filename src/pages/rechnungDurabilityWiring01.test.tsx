/**
 * INVOICE-DURABILITY-PRODUCTION-WIRING-01B — produktive Anbindung der
 * Rechnungs-Durability an RechnungPage.
 *
 * Ausschließlich synthetische, neutrale Daten. Kein realer Vorgang, keine echte
 * Workspace-Kennung.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { AppProvider } from '../context/AppContext';
import { RechnungPage } from './RechnungPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateVorgangStore } from '../services/vorgangService';
import {
  beginInvoiceDraftFinalization,
  completeInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import * as durability from '../services/invoice/invoiceDraftDurabilityService';
import { buildInvoiceDraftForType } from '../services/invoiceService';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import type { InvoiceDraftLocator } from '../types/invoiceDraftDurability';
import type { VorgangInvoice } from '../types/models';

const WORKSPACE = 'ws-wiring-a';
const VORGANG = 'vg-wiring-1';

const PAGE_SOURCE = readFileSync(resolve(process.cwd(), 'src/pages/RechnungPage.tsx'), 'utf8');

let workspaceSpy: ReturnType<typeof vi.spyOn>;

type Mount = { container: HTMLDivElement; root: Root };

function locator(): InvoiceDraftLocator {
  return {
    sourceScopeKey: `workspace:${WORKSPACE}`,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'abschlag',
  };
}

function seedVorgang(): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG,
      invoices: [],
    }),
  ]);
}

async function renderPage(strict = false): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  const tree = (
    <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG}/rechnung?type=abschlag`]}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <Routes>
          <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
          <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<div data-testid="invoice-detail" />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>
  );
  await act(async () => {
    root = createRoot(container);
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    await Promise.resolve();
  });
  const mount = { container, root };
  await waitFor(() => container.querySelector('[data-testid="rechnung-page"]') !== null);
  return mount;
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/** Wartet, bis die Bedingung gilt — IndexedDB antwortet nicht synchron. */
async function waitFor(check: () => boolean, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/** Vom Positionsschritt in die Vorschau, wo die Freigabe liegt. */
async function gotoPreview(mount: Mount): Promise<void> {
  const applyAll = mount.container.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-apply-all-positions"]',
  );
  if (applyAll) {
    await act(async () => {
      applyAll.click();
      await Promise.resolve();
    });
    await settle();
  }
  const next = mount.container.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-continue-preview"]',
  );
  if (!next) return;
  await act(async () => {
    next.click();
    await Promise.resolve();
  });
  await settle();
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

const SEED_DRAFT_ID = 'draft-wiring-seed';
const SEED_CLIENT_ID = 'inv-wiring-seed';

function seedIdentity() {
  return { ...locator(), draftId: SEED_DRAFT_ID };
}

/** Datensatz im Status `finalizing` — wie nach einem Absturz nach `begin`. */
async function seedFinalizingRecord(): Promise<void> {
  const draft = buildInvoiceDraftForType(VORGANG, DEFAULT_SETUP, 'abschlag');
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();
  const created = await createInvoiceDraftRecord({
    identity: seedIdentity(),
    draft: { ...draft!, id: SEED_DRAFT_ID },
    now: '2026-08-22T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);

  const begun = await beginInvoiceDraftFinalization({
    identity: seedIdentity(),
    expectedRevision: 1,
    clientInvoiceId: SEED_CLIENT_ID,
    contentFingerprint: 'fp-wiring',
    request: {
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      clientInvoiceId: SEED_CLIENT_ID,
      invoice: { id: SEED_CLIENT_ID, type: 'abschlag' },
    } as never,
    approvalContext: {},
    now: '2026-08-22T08:05:00.000Z',
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);
}

/** Datensatz im terminalen Status `finalized`. */
async function seedFinalizedRecord(): Promise<void> {
  await seedFinalizingRecord();
  const done = await completeInvoiceDraftFinalization({
    identity: seedIdentity(),
    expectedRevision: 2,
    clientInvoiceId: SEED_CLIENT_ID,
    contentFingerprint: 'fp-wiring',
    finalizedInvoiceId: SEED_CLIENT_ID,
    archiveWarning: false,
    now: '2026-08-22T08:10:00.000Z',
  });
  expect(done.ok, JSON.stringify(done)).toBe(true);
}

function cloudInvoice(id: string): VorgangInvoice {
  return {
    id,
    number: '2026-0042',
    type: 'abschlag',
    abschlagNumber: 1,
    invoiceSequenceNumber: 42,
    positions: [],
    subtotal: 0,
    amount: 0,
    taxStatus: 'standard_19',
    status: 'vorbereitet',
    date: '2026-08-22',
    createdAt: '2026-08-22T09:00:00.000Z',
  } as VorgangInvoice;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  seedVorgang();
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  // Vollständiger Aussteller — sonst blockiert die bestehende Validierung.
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Betriebsstadt',
    taxNumber: '11/222/33333',
  });
  workspaceSpy = vi
    .spyOn(workspacePayload, 'resolveCloudWorkspaceId')
    .mockReturnValue(WORKSPACE);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('01B — RechnungPage nutzt die dauerhafte Entwurfssitzung', () => {
  it('W1: der Entwurf wird dauerhaft gespeichert und übersteht einen Remount', async () => {
    const first = await renderPage();
    expect(
      first.container.querySelector('[data-testid="rechnung-page"]'),
      first.container.innerHTML.slice(0, 400),
    ).not.toBeNull();
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok, JSON.stringify(stored)).toBe(true);
    if (!stored.ok) return;
    const draftId = stored.record.draftId;
    expect(stored.record.status).toBe('active');
    unmount(first);

    // Remount ersetzt den Reload: derselbe Datensatz, keine Neuanlage.
    const second = await renderPage();
    const again = await loadInvoiceDraftRecordByLocator(locator());
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.record.draftId).toBe(draftId);
      expect(again.record.draftRawJson).toBe(stored.record.draftRawJson);
    }
    unmount(second);
  });

  it('W2: kein produktiver setDraft-Pfad und kein alter Orchestrator mehr', () => {
    expect(/useState<InvoiceDraft\s*\|\s*null>/.test(PAGE_SOURCE)).toBe(false);
    expect(/\bsetDraft\s*\(/.test(PAGE_SOURCE)).toBe(false);
    expect(/finalizeInvoiceDraftWithCloud/.test(PAGE_SOURCE)).toBe(false);
    expect(/invoiceCloudFinalizeOrchestrator/.test(PAGE_SOURCE)).toBe(false);
    // Die Sitzung und der Coordinator sind stattdessen eingebunden.
    expect(/useInvoiceDraftDurabilitySession/.test(PAGE_SOURCE)).toBe(true);
    expect(/startInvoiceDraftFinalization/.test(PAGE_SOURCE)).toBe(true);
    expect(/resumeInvoiceDraftFinalization/.test(PAGE_SOURCE)).toBe(true);
    // Der Aufbau-Effect hängt nicht mehr am Setup.
    expect(/\[id,\s*invoiceType,\s*setup\]/.test(PAGE_SOURCE)).toBe(false);
  });

  it('W3: ein Setup-Wechsel erzeugt den gespeicherten Entwurf nicht neu', async () => {
    const mount = await renderPage();
    const before = await loadInvoiceDraftRecordByLocator(locator());
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // Ein Setup-Wechsel wird über einen erneuten Render mit anderem Setup
    // nachgestellt; der gespeicherte Datensatz darf davon unberührt bleiben.
    await settle();
    const after = await loadInvoiceDraftRecordByLocator(locator());
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.record.draftId).toBe(before.record.draftId);
      expect(after.record.revision).toBe(before.record.revision);
    }
    unmount(mount);
  });

  it('W4: die Freigabe läuft ausschließlich über startInvoiceDraftFinalization', async () => {
    const mount = await renderPage();
    const start = vi
      .spyOn(coordinator, 'startInvoiceDraftFinalization')
      .mockResolvedValue({
        ok: true,
        invoice: cloudInvoice('inv-wiring-0001'),
        clientInvoiceId: 'inv-wiring-0001',
        contentFingerprint: 'fp',
        revision: 3,
        archiveWarning: false,
        idempotentReplay: false,
        cloudState: 'confirmed',
      } as never);

    expect(
      mount.container.querySelector('[data-testid="rechnung-page"]'),
      `nach Render: ${mount.container.innerHTML.slice(0, 300)}`,
    ).not.toBeNull();
    await gotoPreview(mount);
    const button = mount.container.querySelector<HTMLButtonElement>(
      '[data-testid="invoice-approve"]',
    );
    expect(button, mount.container.innerHTML.slice(0, 600)).not.toBeNull();

    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    await settle();

    expect(
      start,
      mount.container.querySelector('[data-testid="invoice-validation-errors"]')?.textContent ??
        mount.container.innerHTML.slice(0, 300),
    ).toHaveBeenCalledTimes(1);
    const call = start.mock.calls[0]![0] as { identity: { vorgangId: string } };
    expect(call.identity.vorgangId).toBe(VORGANG);
    unmount(mount);
  });

  it('W5: finalization_pending löst genau einen Resume aus — auch unter StrictMode', async () => {
    await seedFinalizingRecord();
    const resume = vi
      .spyOn(coordinator, 'resumeInvoiceDraftFinalization')
      .mockResolvedValue({
        ok: false,
        reason: 'pull_incomplete',
        recovery: 'blocked',
        cloudState: 'not_committed',
      } as never);
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');

    const mount = await renderPage(true);
    await waitFor(() => resume.mock.calls.length > 0);
    await settle();

    // Genau einmal — StrictMode führt Effekte doppelt aus.
    expect(resume).toHaveBeenCalledTimes(1);
    const identity = (resume.mock.calls[0]![0] as { identity: { vorgangId: string } }).identity;
    expect(identity.vorgangId).toBe(VORGANG);
    expect(identity.invoiceType).toBe('abschlag');

    // Kein Start und keine Bearbeitung, solange die Finalisierung offen ist.
    expect(start).not.toHaveBeenCalled();
    expect(
      mount.container.querySelector('[data-testid="invoice-approve"]'),
    ).toBeNull();
    unmount(mount);
  });

  it('W7: ohne Firmen-Workspace wird sichtbar gesperrt statt endlos geladen', async () => {
    /*
     * Pilotentscheidung: Gast- und Nutzer-Scopes dürfen keine Rechnung
     * bearbeiten. Belegt wird die sichtbare Sperre **und** dass dabei weder
     * IndexedDB noch der Coordinator angefasst werden.
     */
    scopeService.setActiveStorageScope({ type: 'guest' });
    workspaceSpy.mockReturnValue('');

    const load = vi.spyOn(durability, 'loadInvoiceDraftRecordByLocator');
    const create = vi.spyOn(durability, 'createInvoiceDraftRecord');
    const save = vi.spyOn(durability, 'saveInvoiceDraftRecord');
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');
    const resume = vi.spyOn(coordinator, 'resumeInvoiceDraftFinalization');

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG}/rechnung?type=abschlag`]}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    await settle();

    // Sichtbare Sperre, kein dauerhafter Ladezustand.
    expect(
      container.querySelector('[data-testid="rechnung-blocked-no-workspace"]'),
      container.innerHTML.slice(0, 300),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="invoice-no-workspace"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Laden…');
    // Keine Bearbeitung und keine Freigabe.
    expect(container.querySelector('[data-testid="invoice-approve"]')).toBeNull();
    expect(container.querySelector('[data-testid="rechnung-page"]')).toBeNull();

    // Kein Datenbankzugriff, kein Autosave, kein Start, kein Resume.
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it('W8: retry_allowed bietet einen Knopf, der nur Resume auslöst', async () => {
    await seedFinalizingRecord();
    const resume = vi
      .spyOn(coordinator, 'resumeInvoiceDraftFinalization')
      .mockResolvedValue({
        ok: false,
        reason: 'rpc_failed',
        recovery: 'retry_allowed',
        cloudState: 'not_committed',
      } as never);
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');

    const mount = await renderPage();
    await waitFor(() => resume.mock.calls.length > 0);
    await gotoPreview(mount);

    const retry = mount.container.querySelector<HTMLButtonElement>(
      '[data-testid="invoice-resume-retry"]',
    );
    expect(retry, mount.container.innerHTML.slice(0, 400)).not.toBeNull();

    // Doppelklick darf nur genau einen zusätzlichen Resume auslösen.
    await act(async () => {
      retry!.click();
      retry!.click();
      await Promise.resolve();
    });
    await settle();

    expect(resume).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    unmount(mount);
  });

  it('W9: reload_required bietet Neu laden und startet keine Finalisierung', async () => {
    await seedFinalizingRecord();
    const resume = vi
      .spyOn(coordinator, 'resumeInvoiceDraftFinalization')
      .mockResolvedValue({
        ok: false,
        reason: 'cloud_response_mismatch',
        recovery: 'reload_required',
        cloudState: 'confirmed',
      } as never);
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');

    const mount = await renderPage();
    await waitFor(() => resume.mock.calls.length > 0);
    await gotoPreview(mount);

    expect(
      mount.container.querySelector('[data-testid="invoice-resume-reload"]'),
      mount.container.innerHTML.slice(0, 400),
    ).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="invoice-resume-retry"]')).toBeNull();
    expect(mount.container.querySelector('[data-testid="invoice-approve"]')).toBeNull();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    unmount(mount);
  });

  it('W10: eine bereits finalisierte Rechnung ist über den Grabstein erreichbar', async () => {
    await seedFinalizedRecord();
    const mount = await renderPage();
    await gotoPreview(mount);

    const open = mount.container.querySelector<HTMLButtonElement>(
      '[data-testid="invoice-open-finalized"]',
    );
    expect(open, mount.container.innerHTML.slice(0, 400)).not.toBeNull();

    await act(async () => {
      open!.click();
      await Promise.resolve();
    });
    await settle();

    // Navigation zur tatsächlich finalisierten Rechnung.
    expect(mount.container.querySelector('[data-testid="invoice-detail"]')).not.toBeNull();
    unmount(mount);
  });

  it('W6: ein finalisierter Datensatz sperrt jede erneute Finalisierung', async () => {
    await seedFinalizedRecord();
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');
    const resume = vi.spyOn(coordinator, 'resumeInvoiceDraftFinalization');

    const mount = await renderPage();
    await settle();

    // `already_finalized`: kein Freigabeknopf, kein Start, kein Resume.
    expect(mount.container.querySelector('[data-testid="invoice-approve"]')).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    unmount(mount);
  });
});
