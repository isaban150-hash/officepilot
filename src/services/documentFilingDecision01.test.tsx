import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DocumentFilingDecisionPanel } from '../components/documents/DocumentFilingDecisionPanel';
import { DEFAULT_SETUP } from '../data/mockData';
import { resetTestStores } from '../test/resetStores';
import { isCustomerDocumentKind } from './documentClassificationCatalog';
import {
  buildDocumentFilingDecisionDraft,
  confirmDocumentFilingDecision,
  confirmProposedDocumentFilingDecision,
  FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE,
  formatDigitalFolderBreadcrumb,
  isDocumentFilingDecisionConfirmed,
  isHotelExpenseDocument,
  rebuildFilingDecisionDraft,
  resolveFilingScopeFromKind,
} from './documentFilingDecisionService';
import { executeArchiveAtom } from './intakeExecutionAtoms';
import { wouldArchiveOnSmartIntake } from './intakeExecutionGates';
import {
  getInboxItemById,
  getInboxStoreSnapshot,
  hydrateInboxStore,
} from './inboxService';
import { hydrateDocumentStore, getDocumentById } from './documentService';
import { t } from '../i18n';
import type {
  InboxItem,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowResult,
  WorkflowWarning,
} from '../types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-filing-decision-01',
    title: 'Werkvertrag Neubau',
    documentType: 'kundenauftrag',
    sender: 'Müller GmbH',
    priority: 'hoch',
    deadline: null,
    recommendedAction: 'auftrag_annehmen',
    digitalFolder: {
      id: 'dig-wv',
      name: 'Verträge',
      path: '/Kunden/Neubau-Musterstrasse/Verträge/',
    },
    paperFiling: { folderId: 'folder-2', register: 'Verträge', label: 'Kundenaufträge 2026' },
    status: 'neu',
    receivedAt: '2026-07-01',
    recognizedData: {
      kunde: 'Müller GmbH',
      bauvorhaben: 'Neubau Musterstraße',
    },
    officePilotSuggestion: 'Ablegen',
    nextTaskLabel: 'Ablegen',
    securityHint: 'Hinweis',
    classifiedKind: 'werkvertrag',
    markedAsCompanyDocument: true,
    ...overrides,
  };
}

function createHotelInbox(): InboxItem {
  return createInboxItem({
    id: 'inbox-filing-hotel',
    title: 'Hotelrechnung Berlin',
    documentType: 'eingangsrechnung',
    sender: 'Hotel am Park',
    classifiedKind: 'eingangsrechnung',
    digitalFolder: {
      id: 'dig-hotel',
      name: 'Eingangsrechnungen',
      path: '/Steuerberater/2026/07/Eingangsrechnungen/',
    },
    paperFiling: { folderId: 'folder-1', register: '2026', label: 'Eingangsrechnungen 2026' },
    recognizedData: {
      _extractedText: 'Hotelrechnung\nÜbernachtung 2 Nächte\nFrühstück inkl.\nBetrag: 189,00 EUR',
      betrag: '189,00',
    },
  });
}

function createFinanzamtInbox(): InboxItem {
  return createInboxItem({
    id: 'inbox-filing-fa',
    title: 'Finanzamt Schreiben',
    documentType: 'behoerde',
    sender: 'Finanzamt Berlin',
    classifiedKind: 'finanzamt',
    digitalFolder: {
      id: 'dig-fa',
      name: 'Finanzamt',
      path: '/Behörden/Finanzamt/2026/',
    },
    paperFiling: { folderId: 'paper-behoerden', register: 'Finanzamt', label: 'Behörden' },
    recognizedData: {},
  });
}

describe('DOCUMENT-FILING-DECISION-01 / 01A', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    hydrateDocumentStore([]);
    hydrateInboxStore([]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
  });

  function mount(node: ReactElement): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(AppProvider, { initialSetup: setupComplete }, node),
        ),
      );
    });
    return container;
  }

  it('erkennt Kundendokument vs Unternehmensdokument über CUSTOMER_KINDS', () => {
    expect(isCustomerDocumentKind('werkvertrag')).toBe(true);
    expect(isCustomerDocumentKind('auftrag')).toBe(true);
    expect(isCustomerDocumentKind('finanzamt')).toBe(false);
    expect(isCustomerDocumentKind('eingangsrechnung')).toBe(false);
    expect(resolveFilingScopeFromKind('werkvertrag')).toBe('customer');
    expect(resolveFilingScopeFromKind('finanzamt')).toBe('company');
  });

  it('Kundendokument: Scope, Kunde, Projekt, digitale Ablage, Papierhinweis', () => {
    const item = createInboxItem();
    const draft = buildDocumentFilingDecisionDraft(item);

    expect(draft.scope).toBe('customer');
    expect(draft.customerLabel).toBe('Müller GmbH');
    expect(draft.projectLabel).toBe('Neubau Musterstraße');
    expect(draft.digitalFolder.path).toContain('/Kunden/');
    expect(draft.digitalFolder.path).toContain('Verträge');
    expect(draft.skipPhysicalFiling).toBe(false);
    expect(draft.paperFiling?.folderId).toBe('folder-2');
    expect(formatDigitalFolderBreadcrumb(draft.digitalFolder.path)).toContain('→');
    expect(draft.status).toBe('proposed');
    expect(isDocumentFilingDecisionConfirmed(item)).toBe(false);
  });

  it('Hotelrechnung: Unternehmensdokument ohne Kundenzuordnung, Bereich Hotel/Reisekosten', () => {
    const item = createHotelInbox();
    expect(isHotelExpenseDocument(item)).toBe(true);
    const draft = buildDocumentFilingDecisionDraft(item);

    expect(draft.scope).toBe('company');
    expect(draft.specialty).toBe('hotel_travel');
    expect(draft.customerLabel).toBe('');
    expect(draft.projectLabel).toBe('');
    expect(draft.documentKindLabelKey).toBe('filingDecision.kind.hotelrechnung');
    expect(draft.companyAreaLabelKey).toBe('filingDecision.area.hotelTravel');
    expect(t(draft.documentKindLabelKey as 'filingDecision.kind.hotelrechnung', 'de')).toBe(
      'Hotelrechnung',
    );
    expect(t(draft.companyAreaLabelKey as 'filingDecision.area.hotelTravel', 'de')).toMatch(
      /Hotel|Reisekosten/,
    );
    expect(draft.digitalFolder.path).toContain('/Steuerberater/');
    expect(draft.paperFiling?.folderId).toBe('folder-1');
    expect(isCustomerDocumentKind(item.classifiedKind)).toBe(false);
  });

  it('Unternehmensdokument Finanzamt: Behörden-Pfad + Papier Finanzamt', () => {
    const draft = buildDocumentFilingDecisionDraft(createFinanzamtInbox());
    expect(draft.scope).toBe('company');
    expect(draft.companyAreaId).toBe('behoerden');
    expect(draft.digitalFolder.path).toContain('/Behörden/Finanzamt/');
    expect(draft.paperFiling?.register).toBe('Finanzamt');
  });

  it('Confirm-first: Nutzeränderung ersetzt Vorschlag; Persistenz hält Bestätigung', () => {
    const item = createInboxItem();
    hydrateInboxStore([item]);

    expect(isDocumentFilingDecisionConfirmed(getInboxItemById(item.id)!)).toBe(false);

    const draft = rebuildFilingDecisionDraft(
      item,
      buildDocumentFilingDecisionDraft(item),
      {
        customerLabel: 'Schmidt Bau AG',
        projectLabel: 'Anbau Garage',
      },
    );
    expect(draft.customerLabel).toBe('Schmidt Bau AG');
    expect(draft.digitalFolder.path).toContain('Anbau-Garage');
    expect(draft.status).toBe('proposed');

    const confirmed = confirmDocumentFilingDecision(item.id, draft);
    expect(confirmed).not.toBeNull();
    expect(isDocumentFilingDecisionConfirmed(confirmed!)).toBe(true);
    expect(confirmed!.digitalFolder.path).toContain('Anbau-Garage');
    expect(confirmed!.filingDecision?.scope).toBe('customer');
    expect(confirmed!.filingDecision?.customerLabel).toBe('Schmidt Bau AG');

    const snapshot = getInboxStoreSnapshot();
    hydrateInboxStore(snapshot);
    const reloaded = getInboxItemById(item.id)!;
    expect(isDocumentFilingDecisionConfirmed(reloaded)).toBe(true);
    expect(reloaded.filingDecision?.customerLabel).toBe('Schmidt Bau AG');
    expect(reloaded.digitalFolder.path).toContain('Anbau-Garage');
  });

  it('Smart Intake archiviert nicht bei unbestätigter Filing-Entscheidung', () => {
    const item = createInboxItem({ id: 'inbox-filing-archive-blocked' });
    hydrateInboxStore([item]);
    hydrateDocumentStore([]);

    const successSteps: WorkflowExecutionStepId[] = [];
    const failedSteps: WorkflowExecutionFailure[] = [];
    const warnings: WorkflowWarning[] = [];

    const result = executeArchiveAtom(
      item,
      { companyName: 'Mustermann Sanitär GmbH' },
      successSteps,
      failedSteps,
      warnings,
    );

    expect(result.archiveDocumentId).toBeUndefined();
    expect(getInboxItemById(item.id)?.importedToArchive).not.toBe(true);
    expect(failedSteps.some((step) => step.step === 'archive_document')).toBe(true);
    expect(failedSteps[0]?.message).toBe(FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE);
    expect(warnings.some((warning) => warning.id === 'filing_decision_unconfirmed')).toBe(true);
    expect(
      wouldArchiveOnSmartIntake({ companyRelevant: true }, item),
    ).toBe(false);
  });

  it('Smart Intake darf nach ausdrücklicher Bestätigung archivieren', () => {
    const item = createInboxItem({ id: 'inbox-filing-archive-ok' });
    hydrateInboxStore([item]);
    hydrateDocumentStore([]);

    const confirmed = confirmProposedDocumentFilingDecision(getInboxItemById(item.id)!)!;
    expect(isDocumentFilingDecisionConfirmed(confirmed)).toBe(true);
    expect(
      wouldArchiveOnSmartIntake({ companyRelevant: true }, confirmed),
    ).toBe(true);

    const successSteps: WorkflowExecutionStepId[] = [];
    const failedSteps: WorkflowExecutionFailure[] = [];
    const warnings: WorkflowWarning[] = [];

    const result = executeArchiveAtom(
      confirmed,
      { companyName: 'Mustermann Sanitär GmbH' },
      successSteps,
      failedSteps,
      warnings,
    );

    expect(failedSteps).toHaveLength(0);
    expect(successSteps).toContain('archive_document');
    expect(result.archiveDocumentId).toBeTruthy();
    expect(getInboxItemById(item.id)?.importedToArchive).toBe(true);
    expect(getDocumentById(result.archiveDocumentId!)?.digitalFolder.path).toContain('/Kunden/');
  });

  it('keine Archivierungsroute umgeht das Confirm-Gate (executeArchiveAtom)', () => {
    const item = createHotelInbox();
    hydrateInboxStore([item]);
    const successSteps: WorkflowExecutionStepId[] = [];
    const failedSteps: WorkflowExecutionFailure[] = [];
    const warnings: WorkflowWarning[] = [];
    executeArchiveAtom(
      item,
      { companyName: 'Mustermann Sanitär GmbH' },
      successSteps,
      failedSteps,
      warnings,
    );
    expect(getInboxItemById(item.id)?.importedToArchive).not.toBe(true);
    expect(failedSteps[0]?.message).toBe(FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE);
  });

  it('Panel: Bestätigung setzt Confirm-first Freigabe', () => {
    const item = createInboxItem({ id: 'inbox-filing-panel' });
    hydrateInboxStore([item]);
    let latest: InboxItem | null = null;

    const view = mount(
      createElement(DocumentFilingDecisionPanel, {
        item,
        onConfirmed: (updated: InboxItem) => {
          latest = updated;
        },
      }),
    );

    expect(view.querySelector('[data-testid="document-filing-decision-scope-value"]')?.textContent).toMatch(
      /Kunde/i,
    );
    expect(view.querySelector('[data-testid="document-filing-decision-digital-path"]')).toBeTruthy();
    expect(view.querySelector('[data-testid="document-filing-decision-paper-hint"]')?.textContent).toMatch(
      /abheften|Ordner|Register/i,
    );

    act(() => {
      view.querySelector<HTMLButtonElement>('[data-testid="document-filing-decision-confirm"]')?.click();
    });

    expect(latest).not.toBeNull();
    expect(isDocumentFilingDecisionConfirmed(latest!)).toBe(true);
    expect(view.querySelector('[data-testid="document-filing-decision-confirmed"]')).toBeTruthy();
  });

  it('Panel Hotel: zeigt Hotelrechnung und Hotel/Reisekosten, keine Kundenzuordnung', () => {
    const item = createHotelInbox();
    hydrateInboxStore([item]);

    const view = mount(
      createElement(DocumentFilingDecisionPanel, {
        item,
        onConfirmed: () => undefined,
      }),
    );

    expect(view.querySelector('[data-testid="document-filing-decision-document-kind"]')?.textContent).toMatch(
      /Hotelrechnung/,
    );
    expect(
      view.querySelector('[data-testid="document-filing-decision-company-area-label"]')?.textContent,
    ).toMatch(/Hotel|Reisekosten/);
    expect(view.querySelector('[data-testid="document-filing-decision-scope-value"]')?.textContent).toMatch(
      /Unternehmen/i,
    );
    expect(view.querySelector('[data-testid="document-filing-decision-customer"]')).toBeNull();
  });

  it('unused workflow type sanity for wouldArchive gate typing', () => {
    const workflow = { companyRelevant: true } as Pick<WorkflowResult, 'companyRelevant'>;
    expect(wouldArchiveOnSmartIntake(workflow, createInboxItem())).toBe(false);
  });
});
