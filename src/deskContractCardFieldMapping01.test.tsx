/**
 * DASHBOARD-CONTRACT-CARD-FIELD-MAPPING-01B — die Vertragskarte „Heute beachten“
 * zeigt gespeicherte Analysewerte, ohne eine Analyse neu auszuführen.
 *
 * Alle Fixtures sind neutral und synthetisch. Confirm-first: nur eine bestätigte
 * Kundenverknüpfung darf als „Kunde“ erscheinen.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DeskDocumentAttention } from './components/home/DeskDocumentAttention';
import { buildSummaryForInboxItem } from './services/documentSummaryPresentation';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { createCustomer } from './services/customerService';
import { hydrateCustomerStore } from './services/customerStoreService';
import {
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
  upsertDocumentWorkResultFromWorkflow,
} from './services/documentWorkResultService';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import * as intakeWorkflowService from './services/intakeWorkflowService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { hydrateVorgangStore } from './services/vorgangService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { InboxItem } from './types/models';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };
const OWN = 'Eigenbetrieb Muster GmbH';

/** Dokumenttitel als Absender — genau der Wert, der nie ein Kunde sein darf. */
const FILE_TITLE = 'Testvertrag-Datei 2026 – Muster';

const DETECTED_PARTY = 'Beispiel Auftraggeber GmbH';
const PROJECT = 'Neubau Musterhalle – Abschnitt 2';
const SITE = 'Musterweg 5, 12345 Musterstadt';

/** Veraltete recognizedData-Werte, die nie gewinnen dürfen. */
const STALE_PROJECT = 'Altes Bauvorhaben aus 2019';
const STALE_CUSTOMER = 'Datei-Import Stapel 7';

/** Neutraler Vertragstext; Auftraggeber, Bauvorhaben und Baustelle sind verschieden. */
const CONTRACT_TEXT = [
  'Werkvertrag (Bauleistung nach VOB/B)',
  `Auftraggeber: ${DETECTED_PARTY}`,
  `Auftragnehmer: ${OWN}`,
  'Vertragsdatum: 04.05.2026',
  `Bauvorhaben: ${PROJECT}`,
  `Baustelle: ${SITE}`,
  'Gesamtsumme netto 12.000,00 €',
].join('\n');

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-desk-card-01',
    title: FILE_TITLE,
    sender: FILE_TITLE,
    classifiedKind: 'werkvertrag',
    documentType: 'kundenauftrag',
    status: 'neu',
    recognizedData: {
      _vertragstext: CONTRACT_TEXT,
      // Bewusst veraltet: Bauvorhaben alt, Baustelle fälschlich identisch,
      // Kunde ein untauglicher Dateibezug.
      Bauvorhaben: STALE_PROJECT,
      Baustelle: STALE_PROJECT,
      Kunde: STALE_CUSTOMER,
    },
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

/** Analyse einmalig im Test-Setup — die Karte selbst analysiert nie. */
function storeAnalysisSnapshot(item: InboxItem): void {
  const workflow = processUploadedDocument(item.id);
  expect(workflow).not.toBeNull();
  upsertDocumentWorkResultFromWorkflow(workflow!, item);
}

function mountDesk() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <AppProvider initialSetup={completeSetup}>
          <DeskDocumentAttention />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Sichtbare Fakten der Karte als Label/Wert-Paare. */
function cardFacts(container: HTMLElement): Array<{ label: string; value: string }> {
  const card = container.querySelector('[data-testid="desk-document-attention"]');
  expect(card, 'Vertragskarte fehlt').not.toBeNull();
  return [...card!.querySelectorAll('.document-summary-fact, .fact-row, li, p')]
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => {
      const [label, ...rest] = text.split(':');
      return { label: (label ?? '').trim(), value: rest.join(':').trim() };
    });
}

function cardText(container: HTMLElement): string {
  const card = container.querySelector('[data-testid="desk-document-attention"]');
  expect(card).not.toBeNull();
  return (card!.textContent ?? '').replace(/\s+/g, ' ');
}

describe('DASHBOARD-CONTRACT-CARD-FIELD-MAPPING-01B', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateCustomerStore([]);
    hydrateVorgangStore([]);
    hydrateCompanyProfileStore({ ...getCompanyProfile(), companyName: OWN });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — gespeicherte Analyse ohne Kundenverknüpfung zeigt den Auftraggeber', () => {
    const item = seedItem();
    storeAnalysisSnapshot(item);

    // Positive Vorbedingungen: Snapshot vorhanden, verwendbar, mit BI-Werten.
    const snapshot = getDocumentWorkResultForItem(item.id);
    expect(snapshot).not.toBeNull();
    expect(isDocumentWorkResultUsableForDisplay(snapshot!, item)).toBe(true);
    const bi = snapshot!.businessInterpretation;
    expect(bi).toBeTruthy();
    expect(bi!.facts.parties.counterparty?.name).toContain('Beispiel Auftraggeber');
    expect(bi!.facts.subject.project?.value).toContain('Musterhalle');
    expect(bi!.facts.subject.site?.value).toContain('Musterweg');
    expect(bi!.facts.subject.project?.value).not.toBe(bi!.facts.subject.site?.value);
    expect(item.vorgangId).toBeUndefined();

    // Ab hier darf keine weitere Analyse mehr laufen.
    const analyzeSpy = vi.spyOn(intakeWorkflowService, 'processUploadedDocument');
    const view = mountDesk();
    expect(analyzeSpy).not.toHaveBeenCalled();

    const text = cardText(view.container);

    // Label „Auftraggeber“, nicht „Kunde“.
    expect(text).toContain('Auftraggeber');
    expect(text).toContain(DETECTED_PARTY);

    // Bauvorhaben stammt aus der BI, nicht aus den veralteten recognizedData.
    expect(text).toContain(PROJECT);

    // Die Karte zeigt nur die ersten drei Fakten; der Baustellenfakt wird über
    // denselben öffentlichen Weg mit denselben Snapshot-Werten geprüft.
    const summary = buildSummaryForInboxItem(item, {
      language: 'de',
      displayBusinessInterpretation: bi,
      confirmedCustomerName: null,
    });
    const siteFact = summary.facts.find((fact) => fact.id === 'site');
    const projectFact = summary.facts.find((fact) => fact.id === 'project');
    // Die Baustelle stammt aus dem Snapshot; formatSummaryFactValue kürzt die
    // Adresse lediglich für die Anzeige (bestehendes Anzeigeformat).
    expect(siteFact?.value).toContain('Musterweg 5');
    expect(siteFact?.value).toContain('Musterstadt');
    expect(projectFact?.value).toBe(bi!.facts.subject.project?.value);
    expect(projectFact?.value).toBe(PROJECT);
    expect(siteFact?.value).not.toContain(STALE_PROJECT);
    // Bauvorhaben und Baustelle ersetzen einander nicht.
    expect(siteFact?.value).not.toBe(projectFact?.value);

    // Weder Dateititel noch veraltete recognizedData erscheinen als Fakt.
    for (const fact of cardFacts(view.container)) {
      expect(fact.value).not.toContain(FILE_TITLE);
      expect(fact.value).not.toContain(STALE_PROJECT);
      expect(fact.value).not.toContain(STALE_CUSTOMER);
    }
    view.unmount();
  });

  it('Fall B — bestätigte Kundenverknüpfung zeigt den Namen aus dem Customer-Stamm', () => {
    const created = createCustomer({
      name: 'Bestätigter Kunde GmbH',
      street: 'Kundenweg 1',
      zip: '10115',
      city: 'Berlin',
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-desk-card',
        customer: 'Bestätigter Kunde GmbH',
        customerId: created.customer.id,
      }),
    ]);

    const item = seedItem({ vorgangId: 'v-desk-card' });
    storeAnalysisSnapshot(item);
    expect(getInboxItemById(item.id)?.vorgangId).toBe('v-desk-card');

    const view = mountDesk();
    const text = cardText(view.container);

    expect(text).toContain('Bestätigter Kunde GmbH');
    // Der erkannte Auftraggeber überschreibt den bestätigten Kunden nicht.
    expect(text).not.toContain(DETECTED_PARTY);
    expect(text).not.toContain(STALE_CUSTOMER);
    expect(text).not.toContain(FILE_TITLE);
    expect(text).not.toContain(created.customer.id);
    view.unmount();
  });

  it('Fall C — ohne Analyse und ohne Verknüpfung erscheint kein Kunde', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-desk-card-02',
      title: FILE_TITLE,
      sender: FILE_TITLE,
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      status: 'neu',
      recognizedData: {},
    });
    hydrateInboxStore([item]);

    // Positive Vorbedingung: es existiert kein gespeicherter Snapshot.
    expect(getDocumentWorkResultForItem(item.id)).toBeNull();

    const view = mountDesk();
    const facts = cardFacts(view.container);

    for (const fact of facts) {
      expect(fact.value).not.toBe(FILE_TITLE);
      if (fact.label === 'Kunde' || fact.label === 'Auftraggeber') {
        expect(fact.value).toBe('');
      }
    }
    view.unmount();
  });
});
