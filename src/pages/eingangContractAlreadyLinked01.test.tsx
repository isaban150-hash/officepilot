/**
 * CONTRACT-ORDER-ALREADY-LINKED-UX-01D — ein bereits mit einem existierenden
 * Vorgang verbundenes Dokument bietet die Erfassung nirgends erneut an.
 *
 * Realbefund auf iPhone/Safari: Im Eingang meldete der Werkvertrag korrekt
 * „Passender Vorgang gefunden / bereits verknüpft". Nach „Dokument öffnen"
 * stand auf der Detailseite trotzdem wieder „Als Auftrag erfassen" — eine
 * Einladung zur Doppelanlage.
 *
 * 01B hatte nur die Auftragskarte unterdrückt. Dadurch wurde die Experience
 * Card sichtbar, deren Primäraktion für die Familie `contract` dieselbe
 * `accept_contract_order` mit demselben Text ist. Die Aktion war also nicht
 * entfernt, sondern verschoben. Der damalige Test konnte das nicht sehen, weil
 * er nur `data-testid="auftragskarte"` prüfte.
 *
 * Deshalb prüft dieser Test die **Wirkung** statt eines Elements: Auf der
 * gesamten gerenderten Seite darf kein Bedienelement mit dem i18n-Wert von
 * `auftragskarte.action.accept` stehen. Und R8 geht den echten Produktionsweg
 * über die Eingangsliste, statt die Detailseite ideal vorbereitet zu mounten.
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
import { EingangPage } from './EingangPage';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { buildSyntheticWerkvertragText } from '../test/werkvertragMultiSectionFixtures';
import { getInboxItemById, hydrateInboxStore } from '../services/inboxService';
import { hydrateCustomerStore, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getAllVorgaenge, hydrateVorgangStore } from '../services/vorgangService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { buildContractOrderProposal } from '../services/contractIntelligenceService';
import { acceptContractOrderFromProposal } from '../services/contractOrderAcceptService';
import { t } from '../i18n';
import type { InboxItem, Vorgang } from '../types/models';

/*
 * Der Dienst bleibt fachlich unverändert — der Spion belegt nur, dass der
 * Linked-UI-Pfad ihn gar nicht erst erreicht (R6).
 */
vi.mock('../services/contractOrderAcceptService', async () => {
  const actual = await vi.importActual<typeof import('../services/contractOrderAcceptService')>(
    '../services/contractOrderAcceptService',
  );
  return { ...actual, acceptContractOrderFromProposal: vi.fn(actual.acceptContractOrderFromProposal) };
});

const ITEM_ID = 'inbox-already-linked-01b';
const VORGANG_ID = 'vg-already-linked-01b';
const DETAIL_ROUTE = `/ablage/${ITEM_ID}`;

/** Der reale Text, den der Nutzer auf dem iPhone erneut angeboten bekam. */
const ACCEPT_LABEL = t('auftragskarte.action.accept', 'de');
const OPEN_CASE_LABEL = t('documentExperience.action.openCase', 'de');

let currentPath = '';

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({
      id: ITEM_ID,
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

/** Ein Vorgang ohne `contractConfirmation` — erfasst, aber noch nicht bestätigt. */
function seedVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  const vorgang = createTestVorgang({ id: VORGANG_ID, ...overrides });
  delete (vorgang as Partial<Vorgang>).contractConfirmation;
  return vorgang;
}

/**
 * Genau das, was die Erfassung selbst schreibt: `vorgangId` **und**
 * `vorgangLinkStatus: 'created'` (vorgangService.ts:878). So sieht das Dokument
 * auf dem Geraet nach dem ersten „Als Auftrag erfassen" aus.
 */
function linkedItem(): InboxItem {
  return seedItem({ vorgangId: VORGANG_ID, vorgangLinkStatus: 'created' });
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

/**
 * Die echte App-Kette: Liste und Detailseite hängen an denselben Routen wie in
 * Produktion. Kein vorbereiteter Komponentenstatus, keine künstlichen Props.
 */
async function renderApp(entry: string): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage',
              element: createElement('div', null, createElement(PathProbe), createElement(EingangPage)),
            }),
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement(
                'div',
                null,
                createElement(PathProbe),
                createElement(EingangDetailPage),
              ),
            }),
            createElement(Route, {
              path: '/vorgaenge/:id',
              element: createElement(
                'div',
                { 'data-testid': 'vorgang-page' },
                createElement(PathProbe),
              ),
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

/** Die fachliche Zusicherung: nirgendwo auf der Seite eine Erfassungsaktion. */
function acceptActions(): HTMLButtonElement[] {
  return buttonsWithText(ACCEPT_LABEL);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle(12);
}

describe('CONTRACT-ORDER-ALREADY-LINKED-UX-01D', () => {
  /*
   * R1 — der unveränderte Erstdurchlauf.
   *
   * Ohne Verknüpfung bleibt die Erfassung genau wie bisher verfügbar; der Fix
   * darf den normalen ersten Weg nicht beschädigen.
   */
  it('R1: ein unverknüpfter Werkvertrag bietet die Erfassung weiterhin an', async () => {
    hydrateVorgangStore([]);
    hydrateInboxStore([seedItem()]);
    expect(getInboxItemById(ITEM_ID)?.vorgangId ?? '').toBe('');

    await renderApp(DETAIL_ROUTE);

    expect(find('auftragskarte'), 'Auftragskarte fehlt').not.toBeNull();
    expect(acceptActions().length, 'Erfassung im Erstdurchlauf verschwunden').toBeGreaterThan(0);
  });

  /*
   * R2 — nur intelligenter Match, aber kein gespeicherter Link.
   *
   * Gleicher Kunde, gleiche Baustelle — trotzdem ist das Dokument nicht
   * erfasst. Matching darf nicht stillschweigend zu Verknüpfung umgedeutet
   * werden; die bisherige Accept-Semantik bleibt.
   */
  it('R2: ein nur inhaltlich passender, aber nicht verknüpfter Vorgang lässt die Erfassung stehen', async () => {
    hydrateVorgangStore([
      seedVorgang({
        customer: 'Musterbau OWL GmbH',
        baustelle: 'Teststraße 24, 33602 Bielefeld',
      }),
    ]);
    hydrateInboxStore([seedItem()]);
    expect(getInboxItemById(ITEM_ID)?.vorgangId ?? '').toBe('');

    await renderApp(DETAIL_ROUTE);

    expect(acceptActions().length, 'Matching wurde als Verknüpfung missverstanden')
      .toBeGreaterThan(0);
  });

  /*
   * R3 / R4 — der Realbefund.
   *
   * Der Vorgang existiert und trägt **keine** `contractConfirmation`. „Noch
   * nicht bestätigt" ist ein eigener Zustand und darf die Erfassung nicht
   * wieder freischalten. Der Auftragsvorschlag bleibt ausdrücklich erhalten
   * (R9) — der Fix darf nicht dadurch bestehen, dass er verschwindet.
   */
  it('R3/R4: ein verknüpfter, unbestätigter Auftrag zeigt auf der ganzen Seite keine Erfassung', async () => {
    const vorgang = seedVorgang();
    expect(vorgang.contractConfirmation, 'Testvorgang darf nicht bestätigt sein').toBeUndefined();
    hydrateVorgangStore([vorgang]);
    hydrateInboxStore([linkedItem()]);

    await renderApp(DETAIL_ROUTE);

    expect(
      acceptActions().map((button) => button.getAttribute('data-testid')),
      'Erfassung wird irgendwo auf der Seite erneut angeboten',
    ).toEqual([]);
    expect(find('auftragskarte'), 'Auftragskarte erneut sichtbar').toBeNull();
    // Die bestehende Verknüpfung ist erkennbar, und der Weg dorthin steht offen.
    expect(find('document-case-match-reasons')?.textContent ?? '').toContain('verknüpft');
    expect(buttonsWithText(OPEN_CASE_LABEL).length, 'Kein Weg zum bestehenden Auftrag')
      .toBeGreaterThan(0);
  });

  /*
   * R9 — der Vorschlag bleibt bestehen.
   *
   * Sonst wäre der grüne Test wertlos: Ohne Vorschlag gäbe es ohnehin keine
   * Erfassungsaktion, und der eigentliche Fall bliebe ungeprüft.
   */
  it('R9: im verknüpften Fall existiert der Auftragsvorschlag weiterhin', () => {
    hydrateVorgangStore([seedVorgang()]);
    hydrateInboxStore([linkedItem()]);

    const proposal = buildContractOrderProposal(getInboxItemById(ITEM_ID)!);

    expect(proposal, 'Ohne Auftragsvorschlag prüft R3 nichts').not.toBeNull();
  });

  /*
   * R5 / R6 — die Aktion führt zum tatsächlich verknüpften Auftrag, und der
   * Erfassungsdienst wird dabei nicht angefasst.
   */
  it('R5/R6: die Aktion öffnet genau den verknüpften Vorgang, ohne Erfassung', async () => {
    hydrateVorgangStore([seedVorgang()]);
    hydrateInboxStore([linkedItem()]);
    await renderApp(DETAIL_ROUTE);

    await click(buttonsWithText(OPEN_CASE_LABEL)[0]!);

    expect(currentPath).toBe(`/vorgaenge/${VORGANG_ID}`);
    expect(getAllVorgaenge().map((entry) => entry.id)).toEqual([VORGANG_ID]);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(
      vi.mocked(acceptContractOrderFromProposal),
      'Der Linked-UI-Pfad hat den Erfassungsdienst aufgerufen',
    ).not.toHaveBeenCalled();
  });

  /*
   * R7 — die kaputte Verknüpfung.
   *
   * `vorgangId` zeigt ins Leere. Das ist **nicht** dasselbe wie „nicht
   * verknüpft": Es wäre der gefährlichste Fall, weil hier ohne Schutz ein
   * zweiter Vorgang samt zweitem Kunden entstünde.
   */
  it('R7: eine ins Leere zeigende Verknüpfung bietet weder Erfassung noch Neuanlage an', async () => {
    hydrateVorgangStore([]);
    hydrateInboxStore([seedItem({ vorgangId: 'vg-existiert-nicht' })]);

    await renderApp(DETAIL_ROUTE);

    expect(acceptActions(), 'Neuanlage bei kaputter Verknüpfung angeboten').toEqual([]);
    expect(find('auftragskarte')).toBeNull();
    expect(buttonsWithText(t('vorgangIntelligence.action.create', 'de')))
      .toEqual([]);
    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  /*
   * R7b — Altbestand: `vorgangId` ohne gueltigen `vorgangLinkStatus`.
   *
   * Der Vorgang existiert, also darf keine zweite Anlage angeboten werden.
   * Zugleich bleibt die strengere Regel unberuehrt, die das *ungefragte*
   * Oeffnen des Vorgangs an den bestaetigten Linkstatus bindet — hier wird der
   * Vorgang also zugeordnet, nicht direkt geoeffnet.
   */
  it('R7b: eine Verknüpfung ohne Linkstatus zieht die Erfassung trotzdem zurück', async () => {
    hydrateVorgangStore([seedVorgang()]);
    hydrateInboxStore([seedItem({ vorgangId: VORGANG_ID })]);
    expect(getInboxItemById(ITEM_ID)?.vorgangLinkStatus).toBeUndefined();

    await renderApp(DETAIL_ROUTE);

    expect(acceptActions(), 'Altbestand bietet die Erfassung erneut an').toEqual([]);
    expect(find('auftragskarte')).toBeNull();
    expect(getAllVorgaenge().map((entry) => entry.id)).toEqual([VORGANG_ID]);
  });

  /*
   * R8 — der echte Produktionsweg.
   *
   * Genau die Kette, die auf dem iPhone versagt hat: Eingangsliste, „Dokument
   * öffnen", echte Router-Navigation, und die Detailseite baut ihren Zustand
   * selbst auf. Nichts wird vorbereitet.
   */
  it('R8: Eingang → „Dokument öffnen" → Detailseite zeigt keine Erfassung', async () => {
    hydrateVorgangStore([seedVorgang()]);
    hydrateInboxStore([linkedItem()]);

    await renderApp('/ablage');
    expect(currentPath).toBe('/ablage');

    const openDocument = find(`inbox-open-document-${ITEM_ID}`);
    expect(openDocument, 'Die Eingangskarte bietet kein „Dokument öffnen"').not.toBeNull();
    await click(openDocument!);
    await settle();

    expect(currentPath, 'Keine echte Navigation zur Detailseite').toBe(DETAIL_ROUTE);
    expect(
      acceptActions().map((button) => button.textContent),
      'Nach „Dokument öffnen" wird die Erfassung erneut angeboten',
    ).toEqual([]);
    expect(vi.mocked(acceptContractOrderFromProposal)).not.toHaveBeenCalled();
  });

  /*
   * Die zweite Verteidigungslinie im Fachdienst — unverändert, hier nur
   * festgehalten: Bei bestehender Verknüpfung entsteht kein zweiter Vorgang
   * und kein zweiter Kunde.
   */
  it('Dienst: legt bei bestehender Verknüpfung keinen zweiten Vorgang an', () => {
    hydrateVorgangStore([seedVorgang()]);
    hydrateInboxStore([linkedItem()]);
    const item = getInboxItemById(ITEM_ID)!;

    const proposal = buildContractOrderProposal(item);
    expect(proposal, 'Ohne Auftragsvorschlag prüft dieser Fall nichts').not.toBeNull();

    const result = acceptContractOrderFromProposal({
      item,
      proposal: proposal!,
      selectedPositions: [],
      companyName: 'Cirmak Haustechnik GmbH',
      materialStandard: 'betrieb',
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) {
      expect(result.createdNewVorgang).toBe(false);
      expect(result.vorgang.id).toBe(VORGANG_ID);
    }
    expect(getAllVorgaenge().map((entry) => entry.id)).toEqual([VORGANG_ID]);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });
});
