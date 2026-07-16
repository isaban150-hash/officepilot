import { describe, expect, it, beforeEach } from 'vitest';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { t } from '../i18n';
import { createAuftragInboxItem, createTestVorgang, testSetup } from '../test/fixtures';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import {
  buildContractPositionKey,
  buildDefaultContractPositionSelections,
  confirmImportContractPositions,
  confirmImportSafeContractPositions,
  filterConfirmedPositionsForImport,
  hasPositionMathConflict,
  isImportableLvPosition,
} from './contractPositionImportService';
import { hydrateDocumentStore } from './documentService';
import { executeSmartIntake } from './intakeExecutionService';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
  processUploadedDocument,
} from './intakeWorkflowService';
import { buildInvoiceDraftForType } from './invoiceService';
import { hydrateInboxStore } from './inboxService';
import { setTaskStoreForTests } from './taskStore';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import type { EnhancedDetectedOrderPosition } from '../types/documentIntelligence';
import type { DetectedOrderPosition, InboxItem } from '../types/models';

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
  return {
    ...item,
    recognizedData: { ...item.recognizedData },
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
    ...overrides,
  };
}

function createWerkvertragItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-contract-to-order-01',
    title: 'Werkvertrag Confirm-first',
    fileRefId: 'file-ref-contract-01',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      Leistung: 'Badezimmer-Sanierung Müller',
      Angebotssumme: 'ca. 5.070 €',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
    },
    ...overrides,
  });
}

function asEnhanced(
  position: DetectedOrderPosition,
  reviewStatus: EnhancedDetectedOrderPosition['reviewStatus'] = 'confirmed',
): EnhancedDetectedOrderPosition {
  return {
    ...position,
    confidence: reviewStatus === 'confirmed' ? 'high' : 'medium',
    reviewStatus,
  };
}

describe('CONTRACT-TO-ORDER-POSITIONS-01 confirm-first', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
  });

  it('legt vor Bestätigung keine OrderPosition an', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const created = createVorgangFromInboxWithContract(item);
    expect(created).not.toBeNull();
    expect(getVorgangById(created!.vorgang.id)?.orderPositions).toHaveLength(0);
    expect(created!.inbox.vorgangId).toBe(created!.vorgang.id);
    expect(created!.inbox.fileRefId).toBe('file-ref-contract-01');
  });

  it('importiert nur ausgewählte Positionen und ignoriert abgewählte sowie abgelehnte', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    const [first, second, third] = preview.positions;
    expect(first && second && third).toBeTruthy();

    const selections = {
      [buildContractPositionKey(first!)]: 'selected' as const,
      [buildContractPositionKey(second!)]: 'deselected' as const,
      [buildContractPositionKey(third!)]: 'rejected' as const,
    };

    const result = confirmImportContractPositions(created.vorgang.id, preview.positions, selections);
    expect(result.added).toBe(1);
    const vorgang = getVorgangById(created.vorgang.id);
    expect(vorgang?.orderPositions).toHaveLength(1);
    expect(vorgang?.orderPositions[0]?.description).toContain(first!.description);
  });

  it('setzt review_required standardmäßig nicht ausgewählt und markiert Mathematikkonflikte ohne Korrektur', () => {
    const conflictPosition = asEnhanced(
      {
        positionNumber: '99',
        description: 'Konfliktposition Sanitär',
        unit: 'm²',
        quantity: 10,
        unitPrice: 50,
        lineTotal: 900,
      },
      'review_required',
    );
    expect(hasPositionMathConflict(conflictPosition)).toBe(true);
    expect(conflictPosition.lineTotal).toBe(900);

    const selections = buildDefaultContractPositionSelections([conflictPosition]);
    expect(selections[buildContractPositionKey(conflictPosition)]).toBe('needs_review');
    expect(filterConfirmedPositionsForImport([conflictPosition], selections)).toHaveLength(0);
  });

  it('Smart-Intake erzeugt keinen stillen Vollimport', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((entry) => entry.id === 'inbox-001')!, {
      id: 'inbox-smart-intake-no-silent',
      title: 'Werkvertrag Mustermann Sanitär GmbH',
      vorgangId: undefined,
      vorgangTitle: undefined,
      recognizedData: {
        ...MOCK_INBOX_ITEMS[0]!.recognizedData,
        _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    const result = executeSmartIntake(workflow, {
      companyName: testProfile.companyName,
      materialStandard: 'betrieb',
    });

    expect(result.successSteps).toContain('create_vorgang');
    expect(result.successSteps).not.toContain('import_positions');
    expect(result.positionsAdded).toBe(0);
    expect(result.warnings.some((warning) => warning.id === 'positions_need_confirmation')).toBe(
      true,
    );
    expect(getVorgangById(result.vorgangId!)?.orderPositions ?? []).toHaveLength(0);
  });

  it('dedupliziert erneuten Import derselben Vertragsposition', () => {
    const item = createWerkvertragItem({ id: 'inbox-dedupe-positions' });
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    const first = confirmImportSafeContractPositions(created.vorgang.id, preview.positions);
    const second = confirmImportSafeContractPositions(created.vorgang.id, preview.positions);
    expect(first.added).toBe(preview.positions.length);
    expect(second.added).toBe(0);
    expect(getVorgangById(created.vorgang.id)?.orderPositions).toHaveLength(preview.positions.length);
  });

  it('übernimmt keine technischen Anhänge, Materiallisten oder Vertragsklauseln', () => {
    const blocked: DetectedOrderPosition[] = [
      {
        positionNumber: '1',
        description: 'Windlastberechnung Fassade',
        unit: 'Stk',
        quantity: 1,
        unitPrice: 100,
        lineTotal: 100,
      },
      {
        positionNumber: '2',
        description: 'Montagezeichnung Detail A',
        unit: 'Stk',
        quantity: 1,
        unitPrice: 50,
        lineTotal: 50,
      },
      {
        positionNumber: '3',
        description: 'Materialliste ohne Leistungszeile',
        unit: 'Stk',
        quantity: 5,
        unitPrice: 10,
        lineTotal: 50,
      },
      {
        positionNumber: '4',
        description: 'Allgemeine Vertragsbedingungen Gewährleistung',
        unit: 'Pauschal',
        quantity: 1,
        unitPrice: 0,
        lineTotal: 0,
      },
    ];

    for (const position of blocked) {
      expect(isImportableLvPosition(position)).toBe(false);
    }

    const selections = buildDefaultContractPositionSelections(blocked);
    expect(filterConfirmedPositionsForImport(blocked, selections)).toHaveLength(0);
  });

  it('bewahrt createdFromInboxId und fileRefId bei bestätigtem Import', () => {
    const item = createWerkvertragItem({ id: 'inbox-link-preserve' });
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    confirmImportSafeContractPositions(created.vorgang.id, preview.positions);

    const vorgang = getVorgangById(created.vorgang.id);
    expect(vorgang?.createdFromInboxId).toBe(item.id);
    expect(created.inbox.fileRefId).toBe('file-ref-contract-01');
    expect(created.inbox.vorgangId).toBe(created.vorgang.id);
  });

  it('setzt plannedQuantity als Vertragsmenge und lässt Draft-Menge separat bearbeitbar', () => {
    hydrateVorgangStore([]);
    hydrateInboxStore([]);
    const item = createWerkvertragItem({ id: 'inbox-invoice-planned' });
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const fliesenPreview = preview.positions.find((position) =>
      position.description.includes('Fliesenarbeiten'),
    );
    expect(fliesenPreview?.quantity).toBe(28);

    const created = createVorgangFromInboxWithContract(item, undefined, 'unclear', {
      confirmedPositions: [fliesenPreview!],
    });
    expect(created).not.toBeNull();

    const vorgang = getVorgangById(created!.vorgang.id);
    expect(vorgang?.orderPositions).toHaveLength(1);
    expect(vorgang?.orderPositions[0]?.plannedQuantity).toBe(28);

    const draft = buildInvoiceDraftForType(created!.vorgang.id, testSetup, 'rechnung')!;
    expect(draft.positions).toHaveLength(1);
    expect(draft.positions[0]?.plannedQuantity).toBe(28);
    expect(draft.positions[0]?.openQuantity).toBe(28);

    const edited = {
      ...draft,
      positions: draft.positions.map((position) => ({ ...position, quantity: 20 })),
    };
    expect(edited.positions[0]?.quantity).toBe(20);
    expect(getVorgangById(created!.vorgang.id)?.orderPositions[0]?.plannedQuantity).toBe(28);
  });

  it('stellt neue Proposal-Texte in DE/TR/BG bereit', () => {
    const keys = [
      'documentIntelligence.proposal.detectedTitle',
      'documentIntelligence.proposal.reviewHint',
      'documentIntelligence.proposal.onlySelectedHint',
      'documentIntelligence.proposal.unsureNotSelectedHint',
      'documentIntelligence.action.confirmSelectedPositions',
      'documentIntelligence.action.selectAllSafe',
      'documentIntelligence.action.discardProposal',
      'documentIntelligence.status.mathConflict',
    ] as const;

    for (const key of keys) {
      expect(t(key, 'de')).toBeTruthy();
      expect(t(key, 'tr')).toBeTruthy();
      expect(t(key, 'bg')).toBeTruthy();
      expect(t(key, 'tr')).not.toBe(t(key, 'de'));
      expect(t(key, 'bg')).not.toBe(t(key, 'de'));
    }
  });

  it('importiert keine Position wenn der Vorschlag nur Proposal bleibt', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-empty-proposal', orderPositions: [] })]);
    const positions: EnhancedDetectedOrderPosition[] = [
      asEnhanced({
        positionNumber: '1',
        description: 'Nur Vorschlag',
        unit: 'm²',
        quantity: 5,
        unitPrice: 10,
        lineTotal: 50,
      }),
    ];
    const selections = buildDefaultContractPositionSelections(positions);
    selections[buildContractPositionKey(positions[0]!)] = 'deselected';
    const result = confirmImportContractPositions('v-empty-proposal', positions, selections);
    expect(result.added).toBe(0);
    expect(getVorgangById('v-empty-proposal')?.orderPositions).toHaveLength(0);
  });
});
