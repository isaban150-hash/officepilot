import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuftragInboxItem, testSetup } from '../test/fixtures';
import type { EnhancedDetectedOrderPosition } from '../types/documentIntelligence';
import type { InboxItem } from '../types/models';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import * as contractIntelligenceService from './contractIntelligenceService';
import {
  buildContractPositionKey,
  buildDefaultContractPositionSelections,
  confirmImportContractPositions,
  filterConfirmedPositionsForImport,
} from './contractPositionImportService';
import { hydrateDocumentStore } from './documentService';
import { buildInboxWorkflowAnalysisKey } from './inboxWorkflowAnalysisKey';
import { executeSmartIntake } from './intakeExecutionService';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
  importSuggestedPositionsToVorgang,
  processUploadedDocument,
} from './intakeWorkflowService';
import { buildInvoiceDraftForType } from './invoiceService';
import { hydrateInboxStore } from './inboxService';
import * as persistenceService from './persistenceService';
import { setTaskStoreForTests } from './taskStore';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function cloneInbox(item: InboxItem, overrides: Partial<InboxItem> = {}): InboxItem {
  const { recognizedData: recognizedOverride, ...rest } = overrides;
  return {
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    ...rest,
    recognizedData: {
      ...item.recognizedData,
      ...(recognizedOverride ?? {}),
    },
  };
}

function createLargeWerkvertragItem(): InboxItem {
  const pageTexts = Array.from({ length: 40 }, (_, index) => ({
    pageNumber: index + 1,
    text:
      index % 5 === 0
        ? `${SAMPLE_WERKVERTRAG_TEXT}\nSeite ${index + 1}`
        : `Technische Anlage Windlastberechnung Seite ${index + 1}\n`.repeat(40),
  }));
  const recognizedText = pageTexts.map((page) => page.text).join('\n\n');

  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-proposal-open-block-large',
    title: 'Werkvertrag groß Confirm',
    classifiedKind: 'werkvertrag',
    fileRefId: 'file-ref-proposal-block-01',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      Leistung: 'Badezimmer-Sanierung Müller',
      Angebotssumme: 'ca. 5.070 €',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
      _extractedText: recognizedText,
      _pageTexts: JSON.stringify(pageTexts),
    },
  });
}

function createWerkvertragItem(): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-proposal-open-block-01',
    title: 'Werkvertrag Confirm',
    classifiedKind: 'werkvertrag',
    fileRefId: 'file-ref-proposal-block-01',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      Leistung: 'Badezimmer-Sanierung Müller',
      Angebotssumme: 'ca. 5.070 €',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
    },
  });
}

describe('CONTRACT-PROPOSAL-OPEN-BLOCK-01', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Confirm ohne erneute Contract-Intelligence und mit höchstens einem persistAll für Bulk-Import', () => {
    const item = createLargeWerkvertragItem();
    hydrateInboxStore([item]);

    const preview = getContractPreviewForInbox(item);
    expect(preview.positions.length).toBeGreaterThan(0);
    const selected = preview.positions.slice(0, Math.min(8, preview.positions.length));

    const analyzeSpy = vi.spyOn(
      contractIntelligenceService,
      'analyzeContractIntelligenceFromInbox',
    );
    analyzeSpy.mockClear();

    const started = performance.now();
    const created = createVorgangFromInboxWithContract(item, undefined, 'unclear', {
      confirmedPositions: selected,
    });
    const elapsedMs = performance.now() - started;

    expect(created).not.toBeNull();
    expect(elapsedMs).toBeLessThan(2_000);
    expect(analyzeSpy).not.toHaveBeenCalled();

    const vorgang = getVorgangById(created!.vorgang.id);
    expect(vorgang?.orderPositions).toHaveLength(selected.length);
    expect(vorgang?.orderPositions.every((p) => p.plannedQuantity > 0)).toBe(true);

    // Fresh vorgang + isolated bulk import: exactly one persistAll
    const itemB = cloneInbox(item, {
      id: 'inbox-proposal-open-block-large-b',
      vorgangId: undefined,
      vorgangTitle: undefined,
      vorgangLinkStatus: undefined,
    });
    hydrateVorgangStore([]);
    hydrateInboxStore([itemB]);
    const emptyCreated = createVorgangFromInboxWithContract(itemB)!;
    expect(emptyCreated.vorgang.orderPositions).toHaveLength(0);

    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    persistSpy.mockClear();
    const importResult = importSuggestedPositionsToVorgang(emptyCreated.vorgang.id, selected);
    expect(importResult.added).toBe(selected.length);
    expect(persistSpy).toHaveBeenCalledTimes(1);

    persistSpy.mockClear();
    const reimport = importSuggestedPositionsToVorgang(emptyCreated.vorgang.id, selected);
    expect(reimport.added).toBe(0);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('Bulk-Import allein persistiert höchstens einmal', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    expect(created.vorgang.orderPositions).toHaveLength(0);

    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    persistSpy.mockClear();

    const result = importSuggestedPositionsToVorgang(created.vorgang.id, preview.positions);
    expect(result.added).toBe(preview.positions.length);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it('importiert nur bestätigte Positionen; review_required und abgelehnte bleiben draußen', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    const [first, second, third] = preview.positions;
    expect(first && second && third).toBeTruthy();

    const reviewRequired: EnhancedDetectedOrderPosition = {
      ...first!,
      positionNumber: '99',
      description: 'Prüfungspflichtige Position',
      reviewStatus: 'review_required',
      confidence: 'low',
      quantity: 1,
      unitPrice: 10,
      lineTotal: 999,
    };

    const positions = [first!, second!, third!, reviewRequired];
    const selections = {
      [buildContractPositionKey(first!)]: 'selected' as const,
      [buildContractPositionKey(second!)]: 'deselected' as const,
      [buildContractPositionKey(third!)]: 'rejected' as const,
      [buildContractPositionKey(reviewRequired)]: 'needs_review' as const,
    };

    expect(filterConfirmedPositionsForImport(positions, selections)).toHaveLength(1);

    const analyzeSpy = vi.spyOn(
      contractIntelligenceService,
      'analyzeContractIntelligenceFromInbox',
    );
    analyzeSpy.mockClear();

    const result = confirmImportContractPositions(created.vorgang.id, positions, selections);
    expect(analyzeSpy).not.toHaveBeenCalled();
    expect(result.added).toBe(1);
    expect(getVorgangById(created.vorgang.id)?.orderPositions).toHaveLength(1);
  });

  it('dedupliziert erneuten Confirm ohne Doppelpositionen', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    const selections = buildDefaultContractPositionSelections(preview.positions);

    const first = confirmImportContractPositions(created.vorgang.id, preview.positions, selections);
    const second = confirmImportContractPositions(created.vorgang.id, preview.positions, selections);

    expect(first.added).toBeGreaterThan(0);
    expect(second.added).toBe(0);
    expect(getVorgangById(created.vorgang.id)?.orderPositions).toHaveLength(first.added);
  });

  it('Analysis-Key ignoriert vorgangId — kein Full-Reanalysis-Clear nach Confirm', () => {
    const item = createLargeWerkvertragItem();
    const before = buildInboxWorkflowAnalysisKey(item);
    const afterLink = buildInboxWorkflowAnalysisKey({
      ...item,
      vorgangId: 'v-linked',
      status: 'zugeordnet',
    });
    expect(before).toBe(afterLink);

    const afterContentChange = buildInboxWorkflowAnalysisKey({
      ...item,
      recognizedData: {
        ...item.recognizedData,
        _extractedText: `${item.recognizedData._extractedText ?? ''}X`,
      },
    });
    expect(afterContentChange).not.toBe(before);
  });

  it('Smart-Intake weiterhin ohne stillen Positionsimport', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    const analyzeSpy = vi.spyOn(
      contractIntelligenceService,
      'analyzeContractIntelligenceFromInbox',
    );
    analyzeSpy.mockClear();

    confirmFilingDecisionForTests(item.id);
    const result = executeSmartIntake(workflow, {
      companyName: testProfile.companyName,
      materialStandard: 'betrieb',
    });

    expect(result.positionsAdded).toBe(0);
    expect(result.warnings.some((w) => w.id === 'positions_need_confirmation')).toBe(true);
    expect(getVorgangById(result.vorgangId!)?.orderPositions ?? []).toHaveLength(0);
    // create path must not re-run intelligence
    expect(analyzeSpy).not.toHaveBeenCalled();
  });

  it('Rechnungsdraft übernimmt bestätigte OrderPositions', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item, undefined, 'unclear', {
      confirmedPositions: preview.positions,
    })!;
    const draft = buildInvoiceDraftForType(created.vorgang.id, testSetup, 'rechnung');
    expect(draft).not.toBeNull();
    expect(draft!.positions.length).toBeGreaterThan(0);
    expect(draft!.positions[0]?.description).toBeTruthy();
  });
});
