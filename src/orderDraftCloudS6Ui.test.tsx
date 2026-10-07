/**
 * CLOUD-SYNC S6 — die Oberfläche der Auftrags- und Nachtragsentwürfe.
 *
 * Auftragseditor: Konflikt sichtbar und gesperrt, Entscheidung nur nach
 * Rückfrage, ehrliches Verwerfen, neuere Fassung bei ungespeicherten
 * Eingaben, „bereits als Auftrag angelegt". Vorgangsliste: kein Gerätehinweis,
 * Abweichung als Kennzeichen. Nachtragspanel: alle Entwürfe erreichbar, Wechsel
 * ohne mitgenommene Eingaben, Konflikt je Entwurf.
 *
 * Seit Phase 2 ist der Entwurfs-Sync freigegeben: Keine Ansicht behauptet mehr
 * „nur auf diesem Gerät". Nur beim Notausschalter (Entwurfs-Sync aus) kehrt
 * dieser Hinweis zurück — und dann stimmt er.
 * Neutrale Beispieldaten.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t, type TranslationKey } from './i18n';
import { AuftragEditorPage } from './pages/AuftragEditorPage';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { AuthProvider } from './context/AuthContext';
import { VorgaengePage } from './pages/VorgaengePage';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import type { ContractConfirmationSnapshot, OrderAmendment, Vorgang } from './types/models';
import type { OrderDraft, OrderDraftCloudPayload, OrderDraftInput, WorkspaceOrderDraftRow } from './types/orderDraft';
import type { OrderAmendmentDraftCloudPayload } from './types/orderAmendmentDraftCloud';
import { mergeRemoteWorkspacePullIntoState } from './services/workspace/workspaceProvisioningService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  persistAll,
  resetBusinessStateWriteLocksForTests,
} from './services/persistenceService';
import { resetSyncOutboxForTests } from './services/sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from './services/sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from './services/sync/syncClientService';
import { resetStorageScopeForTests, setActiveStorageScope } from './services/storage/storageScopeService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { getVorgangById, hydrateVorgangStore, resetVorgaenge } from './services/vorgangService';
import { disableOrderDraftCloudSyncForTests, enableOrderDraftCloudSyncForTests } from './test/orderDraftCloudSwitch';
import {
  createOrderDraft,
  getOrderDraftById,
  getOrderDraftStoreSnapshot,
  hydrateOrderDrafts,
  resetOrderDrafts,
} from './services/order/orderDraftService';
import { stripOrderDraftForCloud } from './services/order/orderDraftCloudService';
import * as createOrderCloud from './services/order/createOrderCloudService';
import * as workspaceRole from './services/workspace/workspaceRoleService';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from './services/orderAmendmentService';
import { resetOrderAmendmentDraftTombstones } from './services/orderAmendment/orderAmendmentDraftTombstoneStore';
import { resetOrderAmendmentConfirmIntentsForTests } from './services/orderAmendment/orderAmendmentConfirmIntentService';
import { parseWorkspaceOrderAmendmentPullRow } from './services/orderAmendment/workspaceOrderAmendmentCloudService';

const WS = 'ws-order-draft-s6-ui';
const DEVICE = 'device-order-draft-s6-ui';
const NOW = '2026-10-07T09:00:00.000Z';
const VORGANG = 'v-s6-ui-auftrag';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

/* ------------------------------------------------------------------ */
/* Hilfen                                                              */
/* ------------------------------------------------------------------ */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function zeige(node: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function editor(pfad: string): void {
  zeige(
    <MemoryRouter initialEntries={[pfad]}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <Routes>
          <Route path="/auftraege/neu" element={<AuftragEditorPage />} />
          <Route path="/auftraege/entwurf/:draftId" element={<AuftragEditorPage />} />
          <Route path="/vorgaenge" element={<div data-testid="route-vorgaenge" />} />
          <Route path="/vorgaenge/:id" element={<div data-testid="route-vorgang" />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

function liste(): void {
  zeige(
    <MemoryRouter initialEntries={['/vorgaenge']}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <VorgaengePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

function panel(): void {
  const rerender = () => {
    root!.render(
      <VorgangOrderAmendmentPanel vorgang={getVorgangById(VORGANG)!} translate={translate} onUpdated={rerender} onToast={vi.fn()} />,
    );
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(rerender);
}

function el(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function muss(testId: string): HTMLElement {
  const found = el(testId);
  if (!found) throw new Error(`nicht gefunden: ${testId}`);
  return found;
}

async function klick(testId: string): Promise<void> {
  await act(async () => {
    muss(testId).click();
  });
}

function setzeWert(input: HTMLInputElement, wert: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, wert);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function tippe(testId: string, wert: string): void {
  setzeWert(muss(testId) as HTMLInputElement, wert);
}

function wert(testId: string): string {
  return (muss(testId) as HTMLInputElement).value;
}

function eingabe(titel = 'S6 Montage'): OrderDraftInput {
  return {
    customerId: undefined,
    customerBilling: { name: 'Muster Bau GmbH', contactPerson: '', street: 'Weg 6', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    title: titel,
    baustelle: 'Weg 6, Bielefeld',
    positions: [{ id: 'op-s6-ui-1', description: 'Montage', plannedQuantity: 2, unit: 'Stunden', unitPrice: 100 }],
    taxStatus: 'standard_19',
    paymentTermsText: '14 Tage netto',
  };
}

function neu(titel?: string): OrderDraft {
  const r = createOrderDraft(WS, eingabe(titel));
  if (!r.success) throw new Error(r.errorKey);
  return r.draft;
}

function cloudInhalt(id: string, titel: string): OrderDraftCloudPayload {
  return stripOrderDraftForCloud({ ...eingabe(titel), id, workspaceId: WS, createdAt: NOW, updatedAt: NOW } as OrderDraft);
}

function zeile(payload: OrderDraftCloudPayload, rowVersion: number): WorkspaceOrderDraftRow {
  return {
    workspace_id: WS,
    client_draft_id: payload.id,
    status: 'active',
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    consumed_vorgang_id: null,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: NOW,
  };
}

/** Ein Abzug wie in der App: abgleichen, anwenden, danach meldet der Speicher die Änderung. */
function abzug(rows: WorkspaceOrderDraftRow[]): void {
  act(() => {
    const result = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [],
      customers: [],
      orderDrafts: rows,
      orderAmendmentDrafts: [],
    } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);
    applyStateToStores(result.state);
    persistAll();
  });
}

function mitKonflikt(draft: OrderDraft, cloudTitel: string): OrderDraft {
  const konflikt: OrderDraft = {
    ...draft,
    title: 'Hier geändert',
    sync: { updatedAt: NOW, version: 1, deleted: false, deviceId: DEVICE, workspaceId: WS },
    conflict: {
      kind: 'version',
      detectedAt: NOW,
      remote: { rowVersion: 2, status: 'active', deleted: false, payload: cloudInhalt(draft.id, cloudTitel) },
    },
  };
  hydrateOrderDrafts([konflikt]);
  persistAll();
  return konflikt;
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-s6-ui',
    confirmedAt: NOW,
    customer: 'Muster Bau GmbH',
    auftraggeber: 'Muster Bau GmbH',
    baustelle: 'Weg 6',
    title: 'S6 Auftrag',
    positions: [
      { id: 'op-s6-ui-1', description: 'Montage', plannedQuantity: 10, unit: 'Stunden', unitPrice: 65, category: 'arbeit', billable: true },
    ],
    negotiation: { notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
    immutable: true,
  };
}

function auftrag(): Vorgang {
  return createTestVorgang({
    id: VORGANG,
    status: 'beauftragt',
    contractConfirmation: snapshot(),
    orderPositions: [createOrderPosition({ id: 'op-s6-ui-1', plannedQuantity: 10, unit: 'Stunden', unitPrice: 65 })],
  });
}

function nachtrag(titel: string): OrderAmendment {
  const created = createOrderAmendmentDraft(VORGANG, { title: titel });
  if (!created.success) throw new Error(created.errorKey);
  const added = addOrderAmendmentDraftPosition(VORGANG, created.amendment.id, {
    changeType: 'add',
    description: `${titel} Position`,
    quantity: 1,
    unit: 'Stück',
    unitPrice: 10,
  });
  if (!added.success) throw new Error(added.errorKey);
  return added.amendment;
}

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS });
  resetOrderDrafts();
  resetOrderAmendmentDraftTombstones();
  resetOrderAmendmentConfirmIntentsForTests();
  resetVorgaenge();
  persistAll();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Auftragseditor                                                      */
/* ------------------------------------------------------------------ */

describe('S6-UI — Auftragseditor', () => {
  it('UI-E1 — Konflikt: sichtbar, Eingaben gesperrt, Speichern/Anlegen gesperrt; „Cloud-Fassung übernehmen" erst nach Rückfrage', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = mitKonflikt(neu(), 'Vom Tablet');
    editor(`/auftraege/entwurf/${draft.id}`);
    expect(muss('order-draft-cloud-conflict').textContent).toContain(translate('orderDraftCloud.conflict.version.title'));
    expect((muss('order-editor-fields') as HTMLFieldSetElement).disabled).toBe(true);
    expect((muss('order-save-draft') as HTMLButtonElement).disabled).toBe(true);
    expect((muss('order-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(el('order-delete-draft')).toBeNull();
    expect(wert('order-title')).toBe('Hier geändert');

    await klick('order-draft-cloud-takeCloud');
    expect(muss('order-draft-cloud-decision-dialog').textContent).toContain(translate('orderDraftCloud.confirm.takeCloud.body'));
    expect(getOrderDraftById(draft.id)?.conflict).toBeDefined();
    await klick('order-draft-cloud-decision-confirm');

    expect(el('order-draft-cloud-conflict')).toBeNull();
    expect((muss('order-editor-fields') as HTMLFieldSetElement).disabled).toBe(false);
    expect(wert('order-title')).toBe('Vom Tablet');
    expect(getOrderDraftById(draft.id)?.title).toBe('Vom Tablet');
  });

  it('UI-E2 — Abbrechen der Rückfrage ändert nichts', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = mitKonflikt(neu(), 'Vom Tablet');
    editor(`/auftraege/entwurf/${draft.id}`);
    await klick('order-draft-cloud-keepMine');
    await klick('order-draft-cloud-decision-cancel');
    expect(el('order-draft-cloud-conflict')).not.toBeNull();
    expect(getOrderDraftById(draft.id)?.conflict?.kind).toBe('version');
  });

  it('UI-E3 — Verwerfen scheitert am Speicher: Dialog bleibt mit ehrlichem Hinweis offen, der Entwurf bleibt', async () => {
    const draft = neu();
    editor(`/auftraege/entwurf/${draft.id}`);
    await klick('order-delete-draft');
    // Freigegeben: Verwerfen gilt für alle Geräte des Betriebs.
    expect(muss('order-delete-dialog').textContent).toContain(translate('orderDraftCloud.discardText'));
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('voll', 'QuotaExceededError');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await klick('order-delete-confirm');
    setItem.mockRestore();
    expect(muss('simple-confirm-error').textContent).toBe(translate('order.draft.discardFailed'));
    expect(el('order-delete-dialog')).not.toBeNull();
    expect(el('route-vorgaenge')).toBeNull();
    expect(getOrderDraftById(draft.id)?.title).toBe('S6 Montage');
  });

  it('UI-E4 — Notausschalter: der Verwerfen-Dialog spricht nur von diesem Gerät', async () => {
    disableOrderDraftCloudSyncForTests();
    const draft = neu();
    editor(`/auftraege/entwurf/${draft.id}`);
    await klick('order-delete-draft');
    expect(muss('order-delete-dialog').textContent).toContain(translate('order.draft.discardText'));
    expect(muss('order-delete-dialog').textContent).not.toContain(translate('orderDraftCloud.discardText'));
  });

  it('UI-E5 — neuere Fassung aus der Cloud, hier nichts Ungespeichertes: wird geladen', () => {
    enableOrderDraftCloudSyncForTests();
    abzug([zeile(cloudInhalt('v-s6-ui-remote', 'Erste Fassung'), 1)]);
    editor('/auftraege/entwurf/v-s6-ui-remote');
    expect(wert('order-title')).toBe('Erste Fassung');
    abzug([zeile(cloudInhalt('v-s6-ui-remote', 'Zweite Fassung'), 2)]);
    expect(wert('order-title')).toBe('Zweite Fassung');
    expect(el('order-draft-remote-changed')).toBeNull();
  });

  it('UI-E6 — neuere Fassung bei ungespeicherten Eingaben: Hinweis, Speichern gesperrt, nichts still überschrieben', async () => {
    enableOrderDraftCloudSyncForTests();
    abzug([zeile(cloudInhalt('v-s6-ui-remote', 'Erste Fassung'), 1)]);
    editor('/auftraege/entwurf/v-s6-ui-remote');
    tippe('order-title', 'Meine Eingabe');
    abzug([zeile(cloudInhalt('v-s6-ui-remote', 'Zweite Fassung'), 2)]);
    expect(el('order-draft-remote-changed')).not.toBeNull();
    expect(wert('order-title')).toBe('Meine Eingabe');

    await klick('order-save-draft');
    expect(muss('order-editor-error').textContent).toBe(translate('orderDraftCloud.remoteChanged.saveBlocked'));
    expect(getOrderDraftById('v-s6-ui-remote')?.title).toBe('Zweite Fassung');

    await klick('order-draft-remote-load');
    expect(wert('order-title')).toBe('Zweite Fassung');
    expect(el('order-draft-remote-changed')).toBeNull();
  });

  it('UI-E7 — „Meine Eingaben behalten" erlaubt danach das bewusste Speichern', async () => {
    enableOrderDraftCloudSyncForTests();
    abzug([zeile(cloudInhalt('v-s6-ui-remote', 'Erste Fassung'), 1)]);
    editor('/auftraege/entwurf/v-s6-ui-remote');
    tippe('order-title', 'Meine Eingabe');
    abzug([zeile(cloudInhalt('v-s6-ui-remote', 'Zweite Fassung'), 2)]);
    await klick('order-draft-remote-keep');
    expect(el('order-draft-remote-changed')).toBeNull();
    await klick('order-save-draft');
    expect(getOrderDraftById('v-s6-ui-remote')?.title).toBe('Meine Eingabe');
  });

  it('UI-E8 — „bereits als Auftrag angelegt": sichtbarer Hinweis mit Weg zum Auftrag, kein zweiter Versuch', async () => {
    const draft = neu();
    vi.spyOn(createOrderCloud, 'createOrderFromDraftWithCloud').mockResolvedValue({
      ok: false,
      reason: 'already_created',
      vorgangId: draft.id,
      orderNumber: 'A-2026-0042',
    } as Awaited<ReturnType<typeof createOrderCloud.createOrderFromDraftWithCloud>>);
    // Die Testumgebung meldet Supabase als eingerichtet; anlegen darf nur, wer schreiben darf.
    vi.spyOn(workspaceRole, 'resolveWorkspaceWriteAccess').mockReturnValue({
      canWrite: true,
      canIntake: true,
      role: 'owner',
      reason: 'owner_or_admin',
    });
    editor(`/auftraege/entwurf/${draft.id}`);
    await klick('order-confirm');
    await klick('order-confirm-confirm');
    expect(muss('order-draft-already-created').textContent).toContain(translate('orderDraftCloud.create.alreadyCreated'));
    expect((muss('order-confirm') as HTMLButtonElement).disabled).toBe(true);
    await klick('order-draft-already-created-open');
    expect(el('route-vorgang')).not.toBeNull();
  });

  it('UI-E10 — „bereits angelegt" bleibt stehen, auch wenn der Abgleich den Entwurf entfernt; Eingaben gesperrt; erst der Klick führt zum Auftrag', async () => {
    const draft = neu();
    vi.spyOn(workspaceRole, 'resolveWorkspaceWriteAccess').mockReturnValue({
      canWrite: true,
      canIntake: true,
      role: 'owner',
      reason: 'owner_or_admin',
    });
    vi.spyOn(createOrderCloud, 'createOrderFromDraftWithCloud').mockImplementation(async () => {
      // Wie der Abgleich nach „bereits verbraucht": Entwurf weg, Auftrag da.
      hydrateOrderDrafts(getOrderDraftStoreSnapshot().filter((d) => d.id !== draft.id));
      hydrateVorgangStore([createTestVorgang({ id: draft.id, status: 'beauftragt', orderNumber: 'AU-2026-0042' })]);
      persistAll();
      return { ok: false, reason: 'already_created', vorgangId: draft.id, orderNumber: 'AU-2026-0042' } as Awaited<
        ReturnType<typeof createOrderCloud.createOrderFromDraftWithCloud>
      >;
    });
    editor(`/auftraege/entwurf/${draft.id}`);
    await klick('order-confirm');
    await klick('order-confirm-confirm');
    act(() => {
      persistAll();
    });
    expect(el('route-vorgang'), 'keine stille Weiterleitung').toBeNull();
    expect(muss('order-draft-already-created').textContent).toContain('AU-2026-0042');
    expect((muss('order-editor-fields') as HTMLFieldSetElement).disabled).toBe(true);
    expect((muss('order-save-draft') as HTMLButtonElement).disabled).toBe(true);
    expect(el('order-delete-draft')).toBeNull();
    await klick('order-draft-already-created-open');
    expect(el('route-vorgang')).not.toBeNull();
  });

  it('UI-E9 — ohne Abweichung: kein Konfliktbereich, kein Gerätehinweis, normales Bearbeiten', () => {
    const draft = neu();
    editor(`/auftraege/entwurf/${draft.id}`);
    expect(el('order-draft-cloud-conflict')).toBeNull();
    expect(el('order-draft-remote-changed')).toBeNull();
    expect((muss('order-editor-fields') as HTMLFieldSetElement).disabled).toBe(false);
    expect(document.body.textContent).not.toContain('nur auf diesem Gerät');
  });
});

/* ------------------------------------------------------------------ */
/* Auftragsseite                                                       */
/* ------------------------------------------------------------------ */

describe('S6-UI — Auftragsseite', () => {
  it('UI-V1 — ein erst später abgezogener Auftrag erscheint ohne Neuladen', () => {
    zeige(
      <MemoryRouter initialEntries={['/vorgaenge/v-s6-ui-spaeter']}>
        <AuthProvider>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(document.body.textContent).toContain(translate('vorgang.notFound'));
    act(() => {
      hydrateVorgangStore([createTestVorgang({ id: 'v-s6-ui-spaeter', title: 'S6 später angekommen', status: 'beauftragt', orderNumber: 'AU-2026-0043' })]);
      persistAll();
    });
    expect(document.body.textContent).not.toContain(translate('vorgang.notFound'));
    expect(document.body.textContent).toContain('S6 später angekommen');
  });
});

/* ------------------------------------------------------------------ */
/* Vorgangsliste                                                       */
/* ------------------------------------------------------------------ */

describe('S6-UI — Entwurfsliste', () => {
  it('UI-L1 — Notausschalter: „Nur auf diesem Gerät gespeichert."', () => {
    disableOrderDraftCloudSyncForTests();
    neu();
    liste();
    expect(muss('vorgaenge-order-drafts-hint').textContent).toBe('Nur auf diesem Gerät gespeichert.');
  });

  it('UI-L2 — freigegeben: kein Gerätehinweis; ein Entwurf mit Abweichung trägt das Kennzeichen', () => {
    enableOrderDraftCloudSyncForTests();
    const a = neu('Ohne Abweichung');
    const b = neu('Mit Abweichung');
    const konflikt = { ...b, conflict: mitKonflikt(b, 'Vom Tablet').conflict };
    hydrateOrderDrafts([getOrderDraftById(a.id) ?? a, konflikt]);
    persistAll();
    liste();
    expect(el('vorgaenge-order-drafts-hint')).toBeNull();
    expect(muss('vorgaenge-order-drafts').textContent).not.toContain('Nur auf diesem Gerät');
    expect(muss('vorgaenge-order-drafts').textContent).toContain(translate('orderDraftCloud.badge.conflict'));
    expect(el(`order-draft-${a.id}`)).not.toBeNull();
    expect(el(`order-draft-${b.id}`)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Nachtragspanel                                                      */
/* ------------------------------------------------------------------ */

describe('S6-UI — Nachtragspanel', () => {
  beforeEach(() => {
    hydrateVorgangStore([auftrag()]);
    persistAll();
  });

  it('UI-N1 — Notausschalter: ein Entwurf, Hinweis „nur auf diesem Gerät"', () => {
    disableOrderDraftCloudSyncForTests();
    nachtrag('Erster');
    panel();
    expect(muss('order-amendment-local-hint').textContent).toBe(translate('orderAmendment.localOnlyHint'));
    expect(el('order-amendment-extra-drafts')).toBeNull();
  });

  it('UI-N2 — freigegeben: kein Gerätehinweis', () => {
    nachtrag('Erster');
    panel();
    expect(el('order-amendment-local-hint')).toBeNull();
    expect(muss('vorgang-order-amendment-panel').textContent).not.toContain('nur auf diesem Gerät');
  });

  it('UI-N3 — mehrere Entwürfe: alle erreichbar und auswählbar; ein weiterer entsteht bewusst', async () => {
    const erster = nachtrag('Erster');
    const zweiter = nachtrag('Zweiter');
    panel();
    expect(el(`order-amendment-draft-option-${erster.id}`)).not.toBeNull();
    expect(el(`order-amendment-draft-option-${zweiter.id}`)).not.toBeNull();
    expect(muss('order-amendment-header').textContent).toContain('Erster');
    expect(el(`order-amendment-draft-select-${erster.id}`)).toBeNull();

    await klick(`order-amendment-draft-select-${zweiter.id}`);
    expect(muss('order-amendment-header').textContent).toContain('Zweiter');
    expect(el(`order-amendment-position-${zweiter.positions[0]!.id}`)).not.toBeNull();
    expect(el(`order-amendment-position-${erster.positions[0]!.id}`)).toBeNull();

    await klick('order-amendment-prepare-another');
    const alle = getVorgangById(VORGANG)?.orderAmendments ?? [];
    expect(alle).toHaveLength(3);
    const dritter = alle.find((item) => item.id !== erster.id && item.id !== zweiter.id)!;
    expect(el(`order-amendment-draft-option-${dritter.id}`)).not.toBeNull();
    expect(el(`order-amendment-draft-select-${dritter.id}`)).toBeNull();
    expect(el(`order-amendment-draft-select-${erster.id}`)).not.toBeNull();
    expect(el(`order-amendment-draft-select-${zweiter.id}`)).not.toBeNull();
  });

  it('UI-N4 — Wechsel während der Titelbearbeitung nimmt keine Eingaben in den anderen Entwurf mit', async () => {
    const erster = nachtrag('Erster');
    const zweiter = nachtrag('Zweiter');
    panel();
    await klick('order-amendment-edit-draft');
    const titel = muss('order-amendment-header-editing').querySelector('input') as HTMLInputElement;
    setzeWert(titel, 'Getippt für Ersten');
    await klick(`order-amendment-draft-select-${zweiter.id}`);
    expect(el('order-amendment-header-editing')).toBeNull();
    expect(muss('order-amendment-header').textContent).toContain('Zweiter');
    expect(getVorgangById(VORGANG)?.orderAmendments?.find((item) => item.id === zweiter.id)?.title).toBe('Zweiter');
    expect(getVorgangById(VORGANG)?.orderAmendments?.find((item) => item.id === erster.id)?.title).toBe('Erster');
  });

  it('UI-N6 — anderswo bestätigt: der Entwurf verschwindet und sein bestätigter Nachtrag erscheint im selben Moment', () => {
    const draft = nachtrag('Wird anderswo bestätigt');
    const zweiter = nachtrag('Bleibt offen');
    panel();
    expect(muss('order-amendment-summary').textContent).toContain('0');
    act(() => {
      const v = getVorgangById(VORGANG)!;
      hydrateVorgangStore([
        {
          ...v,
          orderAmendments: (v.orderAmendments ?? []).filter((a) => a.id !== draft.id),
          confirmedOrderAmendments: [
            parseWorkspaceOrderAmendmentPullRow(
              {
                id: 'cloud-s6-ui', workspace_id: WS, vorgang_id: VORGANG, client_amendment_id: 'oam-s6-ui-anderswo', sequence_no: 1,
                status: 'bestaetigt', content_fingerprint: 'fp-s6-ui', confirmed_at: NOW, confirmed_by: 'user-anderswo', row_version: 1,
                created_at: NOW, updated_at: NOW,
                payload: {
                  title: 'Wird anderswo bestätigt',
                  positions: [{ id: 'oad-s6-ui-best', changeType: 'add', description: 'Wird anderswo bestätigt Position', plannedQuantity: 1, unit: 'Stück', unitPrice: 10 }],
                  clientAmendmentId: 'oam-s6-ui-anderswo', vorgangId: VORGANG, sequenceNo: 1, sourceDraftId: draft.id,
                },
              },
              WS,
            )!,
          ],
        },
      ]);
      persistAll();
    });
    expect(el(`order-amendment-draft-option-${draft.id}`)).toBeNull();
    expect(muss('order-amendment-header').textContent).toContain('Bleibt offen');
    expect(el('order-amendment-confirmed-1')).not.toBeNull();
    expect(muss('order-amendment-summary').textContent).toContain('1');
    expect(zweiter.id).not.toBe(draft.id);
  });

  it('UI-N5 — Konflikt am ausgewählten Entwurf: sichtbar, Bestätigen und Bearbeiten gesperrt; Entscheidung nach Rückfrage', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = nachtrag('Erster');
    const remote: OrderAmendmentDraftCloudPayload = {
      id: draft.id,
      vorgangId: VORGANG,
      title: 'Vom Tablet',
      positions: [{ id: 'oad-s6-ui-r1', changeType: 'add', description: 'Prüfung', quantity: 1, unit: 'Pauschal', unitPrice: 80 }],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const vorgang = getVorgangById(VORGANG)!;
    hydrateVorgangStore([
      {
        ...vorgang,
        orderAmendments: [
          {
            ...draft,
            sync: { updatedAt: NOW, version: 1, deleted: false, deviceId: DEVICE, workspaceId: WS },
            conflict: { kind: 'version', detectedAt: NOW, remote: { rowVersion: 2, status: 'active', deleted: false, payload: remote } },
          },
        ],
      },
    ]);
    persistAll();
    panel();
    expect(muss('order-amendment-cloud-conflict').textContent).toContain(translate('orderAmendmentCloud.conflict.version.title'));
    // Bestätigen gibt es erst nach der Entscheidung.
    expect(el('order-amendment-confirm')).toBeNull();
    expect((muss('order-amendment-edit-draft') as HTMLButtonElement).disabled).toBe(true);
    expect((muss('order-amendment-add-position') as HTMLButtonElement).disabled).toBe(true);

    await klick('order-amendment-cloud-takeCloud');
    await klick('order-amendment-cloud-decision-confirm');
    expect(el('order-amendment-cloud-conflict')).toBeNull();
    expect(muss('order-amendment-header').textContent).toContain('Vom Tablet');
    expect(el('order-amendment-position-oad-s6-ui-r1')).not.toBeNull();
    expect(el('order-amendment-confirm')).not.toBeNull();
  });
});
