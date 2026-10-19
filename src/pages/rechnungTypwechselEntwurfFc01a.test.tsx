/**
 * FINANZ-CORE-01A — Gesamtabschluss, P3/OBS-6: kein liegengebliebener Entwurf beim Wechsel der
 * Rechnungsart.
 *
 * Der Assistent legt vor der Typwahl einen Entwurf für die Ausgangsart „rechnung“ an. Bisher blieb
 * er beim Wechsel auf Abschlag oder Schlussrechnung dauerhaft aktiv liegen — lokal und in der Cloud
 * (Produktion: 11 Zeilen, alle Version 1). Jetzt wird er verworfen, wenn er nachweislich unberührt
 * ist; ein bearbeiteter oder aus der Cloud übernommener Entwurf bleibt.
 *
 *  E   echte RechnungPage: Wechsel ohne Bearbeitung, Wechsel nach Bearbeitung, neuer Entwurf bleibt bearbeitbar
 *  U   discardUntouchedInvoiceDraftOnTypeSwitch: jede Schutzbedingung einzeln
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import {
  createInvoiceDraftRecord,
  listInvoiceDraftRecordsForWorkspace,
  resetInvoiceDraftDurabilityDatabaseForTests,
  saveInvoiceDraftRecord,
} from '../services/invoice/invoiceDraftDurabilityService';
import { discardUntouchedInvoiceDraftOnTypeSwitch } from '../services/invoice/invoiceDraftCloudBridge';
import { buildInvoiceDraftCoreKeyFromDraft, stripInvoiceDraftForCloud } from '../services/invoice/invoiceDraftCloudService';
import {
  getInvoiceDraftCloudEntity,
  putInvoiceDraftCloudEntity,
  resetInvoiceDraftCloudStore,
} from '../services/invoice/invoiceDraftCloudStore';
import { buildInvoiceDraftForType } from '../services/invoiceService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { InvoiceDraftIdentity } from '../types/invoiceDraftDurability';
import type { InvoiceDraft } from '../types/models';

const WORKSPACE_ID = 'ws-typwechsel-fc01a';
const SETUP = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' as const };

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Typwechsel GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
};

let root: Root;
let host: HTMLDivElement;
let currentSearch = '';

function SearchProbe() {
  currentSearch = useLocation().search;
  return null;
}

beforeEach(async () => {
  try {
    localStorage.clear();
  } catch {
    // ohne Speicher nichts zu leeren
  }
  resetInvoiceNumberSequence();
  resetInvoiceDraftCloudStore();
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  hydrateVorgangStore([
    createTestVorgang({ orderPositions: [createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, executedQuantity: 10 })] }),
  ]);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  currentSearch = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function ticks(count = 30): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderAssistant(search = ''): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/v-test-1/rechnung${search}`]}>
        <AppProvider initialSetup={SETUP}>
          <Routes>
            <Route
              path="/vorgaenge/:id/rechnung"
              element={
                <>
                  <RechnungPage />
                  <SearchProbe />
                </>
              }
            />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (host.querySelector('[data-testid="invoice-type-picker"]')) break;
    await ticks(1);
  }
  await ticks(10);
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await ticks(5);
}

/** Eine echte Eingabe: React liest den Wert über den nativen Setter und das `input`-Ereignis. */
async function tippe(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await ticks(5);
}

async function aktiveEntwuerfe(): Promise<Array<{ draftId: string; invoiceType: string; revision: number }>> {
  const result = await listInvoiceDraftRecordsForWorkspace(WORKSPACE_ID);
  if (!result.ok) throw new Error(`Liste: ${result.reason}`);
  return result.entries
    .filter((entry) => entry.record.status === 'active')
    .map((entry) => ({ draftId: entry.record.draftId, invoiceType: entry.record.invoiceType, revision: entry.record.revision }));
}

describe('E — echte RechnungPage', () => {
  it('E1 Wechsel rechnung → abschlag ohne Bearbeitung: der Ausgangsentwurf wird verworfen, nur der Abschlag bleibt', async () => {
    await renderAssistant();
    const vorher = await aktiveEntwuerfe();
    expect(vorher).toHaveLength(1);
    expect(vorher[0]).toMatchObject({ invoiceType: 'rechnung', revision: 1 });

    await click(find('invoice-type-abschlag')!);
    await ticks(40);

    expect(currentSearch).toContain('type=abschlag');
    const nachher = await aktiveEntwuerfe();
    expect(nachher.map((entry) => entry.invoiceType)).toEqual(['abschlag']);
    // Cloud-Seite: ein Grabstein für den verworfenen Entwurf, damit er auch dort nicht liegen bleibt.
    expect(getInvoiceDraftCloudEntity(vorher[0]!.draftId)?.sync?.deleted).toBe(true);
  });

  it('E2 Wechsel nach einer Bearbeitung: beide Entwürfe bleiben (nichts geht still verloren)', async () => {
    await renderAssistant();
    const von = find('invoice-service-period-from') as HTMLInputElement;
    expect(von).not.toBeNull();
    await tippe(von, von.value === '2026-08-01' ? '2026-08-02' : '2026-08-01');
    await ticks(40);
    const bearbeitet = await aktiveEntwuerfe();
    expect(bearbeitet).toHaveLength(1);
    expect(bearbeitet[0]!.revision).toBeGreaterThan(1);

    await click(find('invoice-type-abschlag')!);
    await ticks(40);

    expect(currentSearch).toContain('type=abschlag');
    const nachher = await aktiveEntwuerfe();
    expect(nachher.map((entry) => entry.invoiceType).sort()).toEqual(['abschlag', 'rechnung']);
    expect(getInvoiceDraftCloudEntity(bearbeitet[0]!.draftId)?.sync?.deleted).not.toBe(true);
  });

  it('E3 der neue Entwurf bleibt nach dem Wechsel bearbeitbar', async () => {
    await renderAssistant();
    await click(find('invoice-type-abschlag')!);
    await ticks(40);
    expect(find('invoice-abschlag-mode-picker')).not.toBeNull();
    await click(find('invoice-abschlag-mode-fixed')!);
    await ticks(20);
    const nachher = await aktiveEntwuerfe();
    expect(nachher).toHaveLength(1);
    expect(nachher[0]).toMatchObject({ invoiceType: 'abschlag' });
    expect(nachher[0]!.revision).toBeGreaterThan(1);
  });
});

describe('U — Schutzbedingungen von discardUntouchedInvoiceDraftOnTypeSwitch', () => {
  async function frisch(): Promise<{ draft: InvoiceDraft; identity: InvoiceDraftIdentity; coreKey: string }> {
    const draft = buildInvoiceDraftForType('v-test-1', SETUP, 'rechnung')!;
    const identity: InvoiceDraftIdentity = {
      sourceScopeKey: `workspace:${WORKSPACE_ID}`,
      workspaceId: WORKSPACE_ID,
      vorgangId: 'v-test-1',
      invoiceType: 'rechnung',
      draftId: draft.id,
    };
    return { draft, identity, coreKey: buildInvoiceDraftCoreKeyFromDraft(draft) };
  }

  async function anlegen(): Promise<{ draft: InvoiceDraft; identity: InvoiceDraftIdentity; coreKey: string; record: NonNullable<Awaited<ReturnType<typeof createInvoiceDraftRecord>> & { ok: true }>['record'] }> {
    const f = await frisch();
    const created = await createInvoiceDraftRecord({ identity: f.identity, draft: f.draft });
    if (!created.ok) throw new Error(`anlegen: ${created.reason}`);
    return { ...f, record: created.record };
  }

  function spiegel(draft: InvoiceDraft, version: number, extra: Record<string, unknown> = {}): void {
    putInvoiceDraftCloudEntity({
      id: draft.id,
      vorgangId: 'v-test-1',
      invoiceType: 'rechnung',
      status: 'active',
      core: stripInvoiceDraftForCloud(draft),
      sync: { updatedAt: '2026-10-14T10:00:00.000Z', deviceId: 'd1', workspaceId: WORKSPACE_ID, version },
      ...extra,
    } as never);
  }

  it('U1 nicht gespiegelt: verworfen, Grabstein Version 0', async () => {
    const f = await anlegen();
    expect(await discardUntouchedInvoiceDraftOnTypeSwitch(f.record, f.draft, f.coreKey)).toEqual({ discarded: true });
    expect(await aktiveEntwuerfe()).toEqual([]);
    expect(getInvoiceDraftCloudEntity(f.draft.id)?.sync).toMatchObject({ deleted: true, version: 0 });
  });

  it('U2 vom Server bestätigte Version 1: verworfen, der Grabstein trägt Version 1 (versionsgeprüft)', async () => {
    const f = await anlegen();
    spiegel(f.draft, 1);
    expect(await discardUntouchedInvoiceDraftOnTypeSwitch(f.record, f.draft, f.coreKey)).toEqual({ discarded: true });
    expect(getInvoiceDraftCloudEntity(f.draft.id)?.sync).toMatchObject({ deleted: true, version: 1 });
  });

  it.each([
    ['unbestätigter erster Versand (Version 0)', 0, {}],
    ['schon weiterbearbeitet (Version 2, anderes Gerät)', 2, {}],
    ['Konflikt', 1, { conflict: { kind: 'remote_changed' } }],
    ['freigegeben', 1, { status: 'finalized' }],
  ])('U3 bleibt: %s', async (_name, version, extra) => {
    const f = await anlegen();
    spiegel(f.draft, version as number, extra as Record<string, unknown>);
    expect(await discardUntouchedInvoiceDraftOnTypeSwitch(f.record, f.draft, f.coreKey)).toEqual({ discarded: false });
    expect(await aktiveEntwuerfe()).toHaveLength(1);
    expect(getInvoiceDraftCloudEntity(f.draft.id)?.sync?.deleted).not.toBe(true);
  });

  it('U4 bleibt: lokal schon gespeichert (Revision 2) — geprüft in der Löschung, auch mit altem Datensatz in der Hand', async () => {
    const f = await anlegen();
    const geaendert = { ...f.draft, introText: `${f.draft.introText ?? ''} geändert` };
    const saved = await saveInvoiceDraftRecord({ identity: f.identity, draft: geaendert, expectedRevision: 1 });
    expect(saved.ok).toBe(true);
    expect(await discardUntouchedInvoiceDraftOnTypeSwitch(f.record, f.draft, f.coreKey)).toEqual({ discarded: false });
    expect(await aktiveEntwuerfe()).toHaveLength(1);
  });

  it('U5 bleibt: Kern weicht vom frisch gebauten ab', async () => {
    const f = await anlegen();
    const anders = { ...f.draft, introText: 'anders' };
    expect(await discardUntouchedInvoiceDraftOnTypeSwitch(f.record, anders, f.coreKey)).toEqual({ discarded: false });
    expect(await aktiveEntwuerfe()).toHaveLength(1);
  });
});
