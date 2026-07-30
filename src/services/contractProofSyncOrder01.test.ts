/**
 * CONTRACT-PROOF-SYNC-ORDER-01 — proof sync after authoritative vorgang create/link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import * as contractProofSyncAfterVorgangLinkService from './contractProofSyncAfterVorgangLinkService';
import { syncContractProofRequirementsAfterVorgangLink } from './contractProofSyncAfterVorgangLinkService';
import {
  addDocument,
  getDocumentById,
  hydrateDocumentStore,
  importInboxDocument,
  linkDocumentToVorgang,
} from './documentService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { executeSmartIntake } from './intakeExecutionService';
import { executeVorgangAtom } from './intakeExecutionAtoms';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  addInboxItem,
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
} from './inboxService';
import {
  getMemoryRelations,
  getProofMemories,
  getProofsByStatus,
  getProofsForVorgang,
  hydrateMemory,
  resetMemory,
  syncContractProofRequirements,
  syncContractProofRequirementsFromInbox,
} from './officePilotMemoryService';
import * as persistenceService from './persistenceService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import {
  confirmFilingDecisionForTests,
  importInboxDocumentForTests,
} from '../test/confirmFilingDecisionForTests';
import { resetTestStores } from '../test/resetStores';
import { hydrateVorgangStore, getVorgangById } from './vorgangService';
import { setWorkspace } from './workspace/workspaceStore';
import type {
  InboxItem,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowResult,
  WorkflowWarning,
} from '../types/models';

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

function createWerkvertragInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-cps-werkvertrag',
    title: 'Werkvertrag Müller Bau',
    documentType: 'kundenauftrag',
    classifiedKind: 'werkvertrag',
    sender: 'Müller Bau GmbH',
    recognizedData: withInboxExtractedDocumentText(
      {
        Kunde: 'Müller Bau GmbH',
        Baustelle: 'Hauptstr. 12, 10115 Berlin',
        Leistung: 'Badezimmer-Sanierung Müller',
      },
      SAMPLE_WERKVERTRAG_TEXT,
    ),
    ...overrides,
  });
}

function seedCompanyAndEmptyStores(): void {
  resetTestStores();
  localStorage.clear();
  resetMemory();
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateCompanyProfileStore(testProfile);
}

function runSmartIntakeForItem(item: InboxItem) {
  hydrateInboxStore([item]);
  const workflow = processUploadedDocument(item.id)!;
  confirmFilingDecisionForTests(item.id);
  return executeSmartIntake(workflow, {
    companyName: testProfile.companyName,
    materialStandard: 'betrieb',
  });
}

function countRequiresProofRelations(vorgangId: string): number {
  return getMemoryRelations().filter(
    (relation) =>
      relation.relation === 'requires_proof' &&
      relation.fromType === 'vorgang' &&
      relation.fromId === vorgangId,
  ).length;
}

describe('CONTRACT-PROOF-SYNC-ORDER-01', () => {
  beforeEach(() => {
    seedCompanyAndEmptyStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1 — Smart Intake neuer Vorgang synchronisiert Proofs nach Create', () => {
    const item = createWerkvertragInbox();
    const result = runSmartIntakeForItem(item);

    expect(result.completed).toBe(true);
    expect(result.successSteps).toContain('archive_document');
    expect(result.successSteps).toContain('create_vorgang');
    expect(result.vorgangId).toBeTruthy();

    const missing = getProofsByStatus('missing');
    expect(missing.length).toBeGreaterThanOrEqual(3);
    expect(getProofsForVorgang(result.vorgangId!).some((p) => p.status === 'missing')).toBe(true);
    expect(countRequiresProofRelations(result.vorgangId!)).toBeGreaterThanOrEqual(3);
  });

  it('2 — Smart Intake bestehender Vorgang synchronisiert Proofs nach Link', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-existing-cps',
        title: 'Badezimmer-Sanierung Müller',
        customer: 'Müller Bau GmbH',
        baustelle: 'Hauptstr. 12, 10115 Berlin',
      }),
    ]);

    const item = createWerkvertragInbox({
      id: 'inbox-cps-link',
      title: 'Werkvertrag zu bestehendem Vorgang',
    });
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    // Force suggested link to our seeded vorgang (stable for this regression).
    const linkedWorkflow: WorkflowResult = {
      ...workflow,
      suggestedVorgang: {
        vorgangId: 'v-existing-cps',
        vorgangTitle: 'Badezimmer-Sanierung Müller',
        customer: 'Müller Bau GmbH',
        confidence: 'high',
        reasonKey: 'test.suggested',
      },
    };
    confirmFilingDecisionForTests(item.id);
    const result = executeSmartIntake(linkedWorkflow, {
      companyName: testProfile.companyName,
      materialStandard: 'betrieb',
    });

    expect(result.successSteps).toContain('link_vorgang');
    expect(result.vorgangId).toBe('v-existing-cps');
    expect(getProofsForVorgang('v-existing-cps').some((p) => p.status === 'missing')).toBe(true);
    expect(countRequiresProofRelations('v-existing-cps')).toBeGreaterThanOrEqual(3);
  });

  it('3 — Sync ohne vorgangId ist No-op; Create-Hook holt nach', () => {
    const item = createWerkvertragInbox({ id: 'inbox-cps-noop-then-create', vorgangId: undefined });
    addInboxItem(item);
    confirmFilingDecisionForTests(item.id);

    const early = syncContractProofRequirementsFromInbox(getInboxItemById(item.id)!);
    expect(early).toBeNull();
    expect(getProofsByStatus('missing')).toHaveLength(0);

    const result = runSmartIntakeForItem(getInboxItemById(item.id)!);
    expect(result.vorgangId).toBeTruthy();
    expect(getProofsForVorgang(result.vorgangId!).length).toBeGreaterThanOrEqual(3);
  });

  it('4 — Pre-linked Import + Nachhol-Sync erzeugt keine Duplikate', () => {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-prelinked', title: 'Prelinked', customer: 'Müller Bau GmbH' }),
    ]);
    const item = createWerkvertragInbox({
      id: 'inbox-cps-prelinked',
      vorgangId: 'v-prelinked',
      vorgangTitle: 'Prelinked',
      vorgangLinkStatus: 'linked',
    });
    addInboxItem(item);
    confirmFilingDecisionForTests(item.id);

    const imported = importInboxDocument(getInboxItemById(item.id)!, testProfile.companyName);
    expect(imported.success).toBe(true);
    const afterImport = getProofsForVorgang('v-prelinked').length;
    expect(afterImport).toBeGreaterThanOrEqual(3);
    const relationCount = countRequiresProofRelations('v-prelinked');

    const again = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-prelinked',
      inboxItem: getInboxItemById(item.id)!,
    });
    expect(again.status).toBe('synced');
    expect(getProofsForVorgang('v-prelinked')).toHaveLength(afterImport);
    expect(countRequiresProofRelations('v-prelinked')).toBe(relationCount);
  });

  it('5 — linkDocumentToVorgang synchronisiert Proofs aus Archivdokument', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-late-link', title: 'Spät' })]);
    const add = addDocument({
      title: 'Werkvertrag Archiv',
      category: 'vertrag',
      issuer: 'Müller Bau GmbH',
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
      classifiedKind: 'werkvertrag',
      linkedCompany: testProfile.companyName,
      archived: true,
      linkedVorgang: null,
    });
    expect(add.success).toBe(true);
    if (!add.success) return;

    expect(getProofsForVorgang('v-late-link')).toHaveLength(0);

    const linked = linkDocumentToVorgang(add.document.id, {
      vorgangId: 'v-late-link',
      vorgangTitle: 'Spät',
    });
    expect(linked.success).toBe(true);
    expect(getProofsForVorgang('v-late-link').length).toBeGreaterThanOrEqual(3);
  });

  it('6 — Reload zwischen Archiv und Vorgang: Nachholung mit Inbox-Zustand', () => {
    const item = createWerkvertragInbox({ id: 'inbox-cps-reload' });
    hydrateInboxStore([item]);
    confirmFilingDecisionForTests(item.id);
    const imported = importInboxDocument(getInboxItemById(item.id)!, testProfile.companyName);
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    const marked = markInboxImportedToArchive(item.id, imported.document.id);
    expect(marked?.item).toBeTruthy();

    // Simulate reload: re-hydrate inbox + empty memory proofs, keep archived doc.
    const reloadedInbox = getInboxItemById(item.id)!;
    hydrateInboxStore([reloadedInbox]);
    hydrateMemory({
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    });
    expect(getProofsByStatus('missing')).toHaveLength(0);

    const workflow = processUploadedDocument(item.id)!;
    const successSteps: WorkflowExecutionStepId[] = [];
    const failedSteps: WorkflowExecutionFailure[] = [];
    const warnings: WorkflowWarning[] = [];

    const outcome = executeVorgangAtom(
      getInboxItemById(item.id)!,
      { ...workflow, suggestedVorgang: null },
      { companyName: testProfile.companyName, materialStandard: 'betrieb', skipArchive: true },
      successSteps,
      failedSteps,
      warnings,
    );

    expect(outcome.vorgangId).toBeTruthy();
    expect(failedSteps).toHaveLength(0);
    expect(getProofsForVorgang(outcome.vorgangId!).length).toBeGreaterThanOrEqual(3);
  });

  it('7 — Mehrfacher Sync: keine doppelten Relations / Missing Proofs', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-idem', title: 'Idem' })]);
    const item = createWerkvertragInbox({
      id: 'inbox-cps-idem',
      vorgangId: 'v-idem',
      vorgangLinkStatus: 'linked',
    });
    addInboxItem(item);

    const first = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-idem',
      inboxItem: item,
    });
    const second = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-idem',
      inboxItem: item,
    });
    expect(first.status).toBe('synced');
    expect(second.status).toBe('synced');

    const missingIds = getProofsByStatus('missing').map((p) => p.id);
    expect(new Set(missingIds).size).toBe(missingIds.length);
    const relationIds = getMemoryRelations()
      .filter((r) => r.fromId === 'v-idem')
      .map((r) => r.id);
    expect(new Set(relationIds).size).toBe(relationIds.length);
  });

  it('8 — Erfüllter Proof bleibt erfüllt und wird nicht auf missing gesetzt', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-fulfilled', title: 'Fulfilled' })]);
    syncContractProofRequirements('v-fulfilled', 'inbox-src', [
      {
        type: 'freistellungsbescheinigung',
        priority: 'hoch',
        reason: 'Im Vertrag gefordert',
      },
    ]);
    expect(getProofsByStatus('missing')).toHaveLength(1);

    const freistellungDoc = addDocument({
      title: 'Freistellung',
      category: 'steuer',
      issuer: 'Finanzamt',
      recognizedText: 'Freistellungsbescheinigung nach §48b EStG',
      classifiedKind: 'freistellungsbescheinigung',
      validUntil: '2027-12-31',
      linkedCompany: testProfile.companyName,
      archived: true,
    });
    expect(freistellungDoc.success).toBe(true);

    const before = getProofMemories().find(
      (p) => p.proofType === 'freistellungsbescheinigung' && p.status !== 'missing',
    );
    expect(before).toBeTruthy();

    const item = createWerkvertragInbox({
      id: 'inbox-cps-fulfilled',
      vorgangId: 'v-fulfilled',
      vorgangLinkStatus: 'linked',
    });
    addInboxItem(item);
    const result = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-fulfilled',
      inboxItem: item,
    });
    expect(result.status).toBe('synced');

    const after = getProofMemories().find(
      (p) => p.proofType === 'freistellungsbescheinigung' && Boolean(p.documentId),
    );
    expect(after?.status).not.toBe('missing');
    expect(after?.documentId).toBeTruthy();
    expect(
      getProofMemories().some(
        (p) =>
          p.id === 'proof-missing-v-fulfilled-freistellungsbescheinigung' &&
          p.status === 'missing',
      ),
    ).toBe(false);
  });

  it('9 — Non-missing Proof-Status bleibt erhalten (kein Reset)', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-status', title: 'Status' })]);
    hydrateMemory({
      documentMemories: [],
      proofMemories: [
        {
          id: 'proof-missing-v-status-bg_bau',
          proofType: 'bg_bau',
          status: 'valid',
          validFrom: null,
          validUntil: '2027-01-01',
          documentMemoryId: null,
          documentId: null,
          requiredByVorgangIds: ['v-status'],
          sourceInboxId: 'inbox-old',
          lastCheckedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      relations: [],
      paperRegisterEntries: [],
    });

    const item = createWerkvertragInbox({
      id: 'inbox-cps-status',
      vorgangId: 'v-status',
      vorgangLinkStatus: 'linked',
    });
    addInboxItem(item);
    syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-status',
      inboxItem: item,
    });

    const protectedProof = getProofMemories().find((p) => p.id === 'proof-missing-v-status-bg_bau');
    expect(protectedProof?.status).toBe('valid');
  });

  it('10 — Nicht-Vertragsdokument: No-op ohne Fehler', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-non', title: 'Non' })]);
    const result = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-non',
      document: {
        id: 'doc-invoice',
        title: 'Rechnung',
        category: 'sonstiges',
        issuer: 'Hornbach',
        recognizedText: 'Materialrechnung Betrag 100 EUR',
        digitalFolder: { id: 'd', name: 'x', path: '/x/' },
        paperFolder: { folderId: 'folder-1', register: 'A', label: 'x' },
        tags: [],
        linkedCompany: testProfile.companyName,
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(result.status).toBe('noop_not_contract');
    expect(getProofsForVorgang('v-non')).toHaveLength(0);
  });

  it('11 — Vertrag ohne Required Documents: sauberer No-op', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-empty-req', title: 'Empty' })]);
    const text = `
Werkvertrag
Auftraggeber: Test AG
Bauvorhaben: Nur Vertrag ohne Nachweisklauseln
Baustellenadresse: Testweg 1
`.trim();
    const result = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-empty-req',
      document: {
        id: 'doc-empty-req',
        title: 'Werkvertrag ohne Nachweise',
        category: 'vertrag',
        issuer: 'Test AG',
        recognizedText: text,
        classifiedKind: 'werkvertrag',
        digitalFolder: { id: 'd', name: 'x', path: '/x/' },
        paperFolder: { folderId: 'folder-1', register: 'A', label: 'x' },
        tags: [],
        linkedCompany: testProfile.companyName,
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(result.status).toBe('noop_no_requirements');
    expect(getProofsForVorgang('v-empty-req')).toHaveLength(0);
  });

  it('12 — Fehlende Textquelle beim späteren Link: kein False Success', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-nosource', title: 'NoSource' })]);
    const add = addDocument({
      title: 'Werkvertrag ohne Text',
      category: 'vertrag',
      issuer: 'Müller Bau',
      recognizedText: '',
      classifiedKind: 'werkvertrag',
      linkedCompany: testProfile.companyName,
      archived: true,
      linkedVorgang: null,
    });
    expect(add.success).toBe(true);
    if (!add.success) return;

    const linked = linkDocumentToVorgang(add.document.id, {
      vorgangId: 'v-nosource',
      vorgangTitle: 'NoSource',
    });
    expect(linked.success).toBe(false);
    if (!linked.success) {
      expect(linked.errorKey).toBe('document.contractProofSourceUnavailable');
    }
    expect(getDocumentById(add.document.id)?.linkedVorgang?.vorgangId).toBe('v-nosource');
  });

  it('13 — Persistenzfehler beim Nachhol-Sync: kein vollständiger Erfolg', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-persist-fail', title: 'Persist' })]);
    const item = createWerkvertragInbox({
      id: 'inbox-cps-persist-fail',
      vorgangId: 'v-persist-fail',
      vorgangLinkStatus: 'linked',
    });
    addInboxItem(item);

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    const helperResult = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-persist-fail',
      inboxItem: item,
    });
    expect(helperResult.status).toBe('persist_failed');

    vi.restoreAllMocks();
    const item2 = createWerkvertragInbox({ id: 'inbox-cps-persist-fail-atom' });
    hydrateInboxStore([item2]);
    const workflow = processUploadedDocument(item2.id)!;
    confirmFilingDecisionForTests(item2.id);
    importInboxDocumentForTests(getInboxItemById(item2.id)!, testProfile.companyName);

    vi.spyOn(
      contractProofSyncAfterVorgangLinkService,
      'syncContractProofRequirementsAfterVorgangLink',
    ).mockReturnValue({
      status: 'persist_failed',
      message: 'Proof-Sync konnte nicht dauerhaft gespeichert werden.',
    });

    const successSteps: WorkflowExecutionStepId[] = [];
    const failedSteps: WorkflowExecutionFailure[] = [];
    const warnings: WorkflowWarning[] = [];
    const outcome = executeVorgangAtom(
      getInboxItemById(item2.id)!,
      { ...workflow, suggestedVorgang: null },
      { companyName: testProfile.companyName, materialStandard: 'betrieb', skipArchive: true },
      successSteps,
      failedSteps,
      warnings,
    );

    expect(outcome.vorgangId).toBeTruthy();
    expect(failedSteps.some((f) => f.step === 'create_vorgang')).toBe(true);
    expect(warnings.some((w) => w.id === 'contract_proof_sync_failed')).toBe(true);
  });

  it('14 — Falscher Workspace: Sync abgelehnt', () => {
    setWorkspace({
      id: 'ws-local-cps',
      name: 'Local',
      ownerUserId: 'user-cps',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    hydrateVorgangStore([createTestVorgang({ id: 'v-ws', title: 'WS' })]);
    const item = createWerkvertragInbox({
      id: 'inbox-cps-ws',
      vorgangId: 'v-ws',
      vorgangLinkStatus: 'linked',
    });
    addInboxItem(item);

    const result = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-ws',
      inboxItem: item,
      workspaceId: 'ws-foreign-other',
    });
    expect(result.status).toBe('workspace_rejected');
    expect(getProofsForVorgang('v-ws')).toHaveLength(0);

    const missingVorgang = syncContractProofRequirementsAfterVorgangLink({
      vorgangId: 'v-does-not-exist',
      inboxItem: item,
    });
    expect(missingVorgang.status).toBe('vorgang_not_found');
  });

  it('15 — K1 Filing-Guard bleibt aktiv', () => {
    const item = createWerkvertragInbox({ id: 'inbox-cps-k1' });
    addInboxItem(item);
    // No confirm
    const result = importInboxDocument(item, testProfile.companyName);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('document.filingDecisionRequired');
    }
  });

  it('16 — K2: fehlgeschlagenes Dokumentupdate verhindert Proof-Sync', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-k2', title: 'K2' })]);
    const add = addDocument({
      title: 'Werkvertrag K2',
      category: 'vertrag',
      issuer: 'Müller Bau',
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
      classifiedKind: 'werkvertrag',
      linkedCompany: testProfile.companyName,
      archived: true,
      linkedVorgang: null,
    });
    expect(add.success).toBe(true);
    if (!add.success) return;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const linked = linkDocumentToVorgang(add.document.id, {
      vorgangId: 'v-k2',
      vorgangTitle: 'K2',
    });
    expect(linked.success).toBe(false);
    expect(getDocumentById(add.document.id)?.linkedVorgang).toBeNull();
    expect(getProofsForVorgang('v-k2')).toHaveLength(0);
  });

  it('17 — Smart Intake bestehender Vertrags-Flow bleibt abgeschlossen', () => {
    const item = createWerkvertragInbox({ id: 'inbox-cps-green' });
    const result = runSmartIntakeForItem(item);
    expect(result.completed).toBe(true);
    expect(result.failedSteps).toHaveLength(0);
    expect(getVorgangById(result.vorgangId!)).toBeTruthy();
  });
});
