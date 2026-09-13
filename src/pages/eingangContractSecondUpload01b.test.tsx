/**
 * INBOX-CONTRACT-SECOND-UPLOAD-01B — derselbe Werkvertrag ein zweites Mal.
 *
 * Realbefund (iPhone, lokal reproduziert): Der zweite, als eigener Eintrag
 * gespeicherte Werkvertrag meldet korrekt „Passender Vorgang gefunden" auf den
 * bereits erfassten Vertragsvorgang — und bietet trotzdem erneut
 * „Als Auftrag erfassen" samt Kundenentscheidung an. Lokal entstand daraus ein
 * zweiter Vorgang und ein zweiter Kunde; auf dem Realgerät griff erst beim
 * Ausführen die Bestätigt-Sperre („Nachtrag").
 *
 * 01D (Already-Linked) kannte nur den persistent verknüpften Fall A. Hier wird
 * die Zustandsgrenze ausdrücklich getestet:
 *
 *   FALL A  Item persistent verknüpft                      → Vorgang öffnen (01D, unverändert)
 *   FALL B  kein Link, sicherer Match auf bestätigten
 *           Vertragsvorgang (contractConfirmation ODER aus
 *           genau dieser Vertragsannahme entstanden)        → Vorgang öffnen, keine Erfassung
 *   FALL C  nur ähnlicher, unbestätigter Vorgang            → Erfassung bleibt (confirm-first)
 *   FALL D  kein passender Vorgang                          → Erfassung bleibt
 *
 * Confirm-first bleibt erhalten: „Vorgang öffnen" navigiert nur; es wird kein
 * `vorgangId` am Dokument gesetzt.
 *
 * Synthetische Daten, kein Netz, keine produktive Erfassung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { EingangDetailPage } from './EingangDetailPage';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { buildSyntheticWerkvertragText } from '../test/werkvertragMultiSectionFixtures';
import { getInboxItemById, hydrateInboxStore } from '../services/inboxService';
import { hydrateCustomerStore, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getAllVorgaenge, hydrateVorgangStore } from '../services/vorgangService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { acceptContractOrderFromProposal } from '../services/contractOrderAcceptService';
import { t } from '../i18n';
import type { InboxItem, Vorgang } from '../types/models';

vi.mock('../services/contractOrderAcceptService', async () => {
  const actual = await vi.importActual<typeof import('../services/contractOrderAcceptService')>(
    '../services/contractOrderAcceptService',
  );
  return { ...actual, acceptContractOrderFromProposal: vi.fn(actual.acceptContractOrderFromProposal) };
});

const FIRST_ITEM_ID = 'inbox-second-upload-first';
const SECOND_ITEM_ID = 'inbox-second-upload-second';
const VORGANG_ID = 'vg-second-upload-01b';
const DETAIL_ROUTE = `/ablage/${SECOND_ITEM_ID}`;

const ACCEPT_LABEL = t('auftragskarte.action.accept', 'de');
const OPEN_CASE_LABEL = t('documentExperience.action.openCase', 'de');

let currentPath = '';

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function seedItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({
      id,
      title: 'Werkvertrag Musterbau OWL GmbH',
      sender: 'Musterbau OWL GmbH',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      recognizedData: {
        Kunde: 'Musterbau OWL GmbH',
        Baustelle: 'Teststraße 24, 33602 Bielefeld',
        _vertragstext: buildSyntheticWerkvertragText(),
      },
    }),
    ...overrides,
  } as InboxItem;
}

/** Der erste Vertrag: erfasst und persistent verknüpft (so schreibt es die Erfassung). */
function firstItem(): InboxItem {
  return seedItem(FIRST_ITEM_ID, { vorgangId: VORGANG_ID, vorgangLinkStatus: 'created' });
}

/** Der zweite Eintrag: identischer Inhalt, **kein** persistenter Link. */
function secondItem(): InboxItem {
  return seedItem(SECOND_ITEM_ID);
}

/** Inhaltlich passender Vorgang (gleicher Kunde, gleiche Baustelle). */
function matchingVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id: VORGANG_ID,
    customer: 'Musterbau OWL GmbH',
    baustelle: 'Teststraße 24, 33602 Bielefeld',
    ...overrides,
  });
}

function withoutConfirmation(vorgang: Vorgang): Vorgang {
  delete (vorgang as Partial<Vorgang>).contractConfirmation;
  return vorgang;
}

/** Bestätigter Vertragsauftrag: Snapshot passt zum Plan (sonst richtet der Store den Plan am Snapshot aus). */
function withConfirmation(vorgang: Vorgang): Vorgang {
  const positions = vorgang.orderPositions.map((position) => ({
    id: position.id,
    description: position.description,
    plannedQuantity: position.plannedQuantity,
    unit: position.unit,
    unitPrice: position.unitPrice,
  }));
  return {
    ...vorgang,
    status: 'beauftragt',
    contractConfirmation: {
      id: 'cc-second-upload',
      confirmedAt: '2026-09-01T10:00:00.000Z',
      customer: vorgang.customer,
      auftraggeber: vorgang.customer,
      baustelle: vorgang.baustelle,
      title: vorgang.title,
      positions,
      negotiation: { conducted: false, notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
      immutable: true,
    },
  } as Vorgang;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  hydrateCustomerStore([]);
  currentPath = '';
  vi.mocked(acceptContractOrderFromProposal).mockClear();
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(rounds = 40): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderDetail(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [DETAIL_ROUTE] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement('div', null, createElement(PathProbe), createElement(EingangDetailPage)),
            }),
            createElement(Route, {
              path: '/vorgaenge/:id',
              element: createElement('div', { 'data-testid': 'vorgang-page' }, createElement(PathProbe)),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function buttonsWithText(label: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button')).filter(
    (button) => (button.textContent ?? '').trim() === label,
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle(12);
}

describe('INBOX-CONTRACT-SECOND-UPLOAD-01B — Fall B: sicherer Match auf bestätigten Vertragsvorgang', () => {
  it('B1: contractConfirmation vorhanden → keine Erfassung, keine Kundenentscheidung, Match sichtbar', async () => {
    hydrateVorgangStore([withConfirmation(matchingVorgang())]);
    hydrateInboxStore([secondItem()]);
    expect(getInboxItemById(SECOND_ITEM_ID)?.vorgangId ?? '').toBe('');

    await renderDetail();

    const match = find('document-case-match');
    expect(match, 'Der passende Vorgang wird nicht angezeigt').not.toBeNull();
    expect(match!.getAttribute('data-match-status')).toBe('exact');
    expect(buttonsWithText(ACCEPT_LABEL), 'Erfassung trotz bestätigtem Vertragsvorgang angeboten').toHaveLength(0);
    expect(find('contract-customer-decision'), 'Kundenentscheidung trotz bestätigtem Vertragsvorgang').toBeNull();
    expect(buttonsWithText(OPEN_CASE_LABEL).length, 'Keine Aktion zum bestehenden Vorgang').toBeGreaterThan(0);
  });

  it('B2: „Vorgang öffnen" führt exakt zum bestehenden Vorgang — ohne Erfassung, ohne Link, ohne zweiten Kunden', async () => {
    hydrateVorgangStore([withConfirmation(matchingVorgang())]);
    hydrateInboxStore([secondItem()]);

    await renderDetail();
    await click(buttonsWithText(OPEN_CASE_LABEL)[0]!);

    expect(currentPath).toBe(`/vorgaenge/${VORGANG_ID}`);
    expect(getAllVorgaenge().map((entry) => entry.id)).toEqual([VORGANG_ID]);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(vi.mocked(acceptContractOrderFromProposal)).not.toHaveBeenCalled();
    // Confirm-first: ein Match ist keine persistente Verknüpfung.
    expect(getInboxItemById(SECOND_ITEM_ID)?.vorgangId ?? '').toBe('');
  });

  /*
   * B3 — der lokal reproduzierte Fall: Der erste Vertrag wurde als Auftrag
   * erfasst (Vorgang aus genau dieser Vertragsannahme entstanden), trägt aber
   * (noch) keine `contractConfirmation`, weil die Testwelt keine Positionen
   * liefert. Fachlich ist der Vertragsauftrag damit trotzdem erfasst — ein
   * zweiter Auftrag aus demselben Vertrag wäre die Doppelanlage, die lokal
   * tatsächlich entstand (zweiter Vorgang, zweiter Kunde).
   */
  it('B3: Vorgang aus derselben Vertragsannahme entstanden (ohne contractConfirmation) → ebenfalls keine zweite Erfassung', async () => {
    hydrateVorgangStore([withoutConfirmation(matchingVorgang({ createdFromInboxId: FIRST_ITEM_ID }))]);
    hydrateInboxStore([firstItem(), secondItem()]);

    await renderDetail();

    expect(buttonsWithText(ACCEPT_LABEL), 'Zweite Erfassung desselben Vertrags angeboten').toHaveLength(0);
    expect(find('contract-customer-decision')).toBeNull();
    expect(buttonsWithText(OPEN_CASE_LABEL).length).toBeGreaterThan(0);
  });
});

describe('INBOX-CONTRACT-SECOND-UPLOAD-01B — Zustandsgrenzen bleiben', () => {
  it('C: nur ähnlicher, unbestätigter Vorgang ohne Vertragsherkunft → Erfassung bleibt (confirm-first)', async () => {
    hydrateVorgangStore([withoutConfirmation(matchingVorgang())]);
    hydrateInboxStore([secondItem()]);

    await renderDetail();

    expect(buttonsWithText(ACCEPT_LABEL).length, 'Fall C wurde wie Fall B behandelt').toBeGreaterThan(0);
    expect(buttonsWithText(OPEN_CASE_LABEL)).toHaveLength(0);
  });

  it('C2: Vorgang mit fremder Herkunft (anderes Dokument, kein Vertrag) → Erfassung bleibt', async () => {
    const otherSource = seedItem('inbox-other-source', {
      classifiedKind: 'brief',
      documentType: 'brief',
      vorgangId: VORGANG_ID,
      vorgangLinkStatus: 'created',
    });
    hydrateVorgangStore([withoutConfirmation(matchingVorgang({ createdFromInboxId: 'inbox-other-source' }))]);
    hydrateInboxStore([otherSource, secondItem()]);

    await renderDetail();

    expect(buttonsWithText(ACCEPT_LABEL).length).toBeGreaterThan(0);
  });

  it('D: kein passender Vorgang → Erfassung bleibt', async () => {
    hydrateVorgangStore([]);
    hydrateInboxStore([secondItem()]);

    await renderDetail();

    expect(find('document-case-match')).toBeNull();
    expect(buttonsWithText(ACCEPT_LABEL).length).toBeGreaterThan(0);
  });

  it('A: persistent verknüpftes Item verhält sich weiterhin wie 01D', async () => {
    hydrateVorgangStore([withConfirmation(matchingVorgang())]);
    hydrateInboxStore([seedItem(SECOND_ITEM_ID, { vorgangId: VORGANG_ID, vorgangLinkStatus: 'created' })]);

    await renderDetail();

    expect(buttonsWithText(ACCEPT_LABEL)).toHaveLength(0);
    expect(buttonsWithText(OPEN_CASE_LABEL).length).toBeGreaterThan(0);
  });
});
