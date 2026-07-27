import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
} from '../types/documentIntelligence';
import type {
  InboxItem,
  Vorgang,
  WorkflowNextAction,
  WorkflowResult,
} from '../types/models';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './contractIntelligenceService';
import { interpretBusinessFromWorkflow } from './businessInterpretationService';
import * as businessInterpretationService from './businessInterpretationService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateInboxStore } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import * as taskEngineService from './taskEngineService';
import * as vorgangService from './vorgangService';
import { hydrateVorgangStore } from './vorgangService';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
  SAMPLE_EINGANGSRECHNUNG_TEXT,
} from '../test/werkvertragMultiSectionFixtures';

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

function baseInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-bbi-01a',
    classifiedKind: 'sonstiges',
    documentType: 'sonstiges',
    ...overrides,
  });
}

function emptyIntelligence(
  overrides: Partial<ContractIntelligenceResult> = {},
): ContractIntelligenceResult {
  return {
    documentLabelKey: 'documentIntelligence.label.werkvertrag',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [],
      billOfQuantitiesPages: [],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {},
    positions: [],
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
    ...overrides,
  };
}

function workflowCore(
  item: InboxItem,
  overrides: Partial<Omit<WorkflowResult, 'businessInterpretation'>> = {},
): Omit<WorkflowResult, 'businessInterpretation'> {
  const nextActions: WorkflowNextAction[] = overrides.nextActions ?? [
    { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
    { id: 'cancel', labelKey: 'intake.action.cancel', enabled: true },
  ];

  return {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
    classifiedKind: item.classifiedKind ?? 'sonstiges',
    classificationConfidence: 'medium',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: null,
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: item.digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions,
    ...overrides,
  };
}

function interpret(
  item: InboxItem,
  overrides: Partial<Omit<WorkflowResult, 'businessInterpretation'>> = {},
  linkedVorgang?: Vorgang | null,
): BusinessInterpretationResult {
  return interpretBusinessFromWorkflow({
    item,
    workflow: workflowCore(item, overrides),
    linkedVorgang,
  });
}

describe('BUSINESS-BRAIN-01A — businessInterpretationService', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    hydrateInboxStore([]);
  });

  it('1) Vertrag erzeugt read-only Verständnis ohne Vorgang/Positionen anzulegen', () => {
    const createSpy = vi.spyOn(vorgangService, 'createVorgangFromInbox');
    const appendSpy = vi.spyOn(vorgangService, 'appendOrderPositionsBulk');
    const taskSpy = vi.spyOn(taskEngineService, 'createTasksFromProposals');

    const item = baseInbox({
      id: 'inbox-bbi-contract',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      title: 'Werkvertrag Müller',
    });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: ['Werkvertrag'],
      },
      parties: [
        {
          role: 'auftraggeber',
          name: 'Müller Bau GmbH',
          status: 'confirmed',
          confidence: 'high',
        },
        {
          role: 'auftragnehmer',
          name: 'Mustermann Sanitär GmbH',
          status: 'confirmed',
          confidence: 'high',
        },
      ],
      positions: [
        {
          description: 'Fliesenarbeiten',
          unit: 'm²',
          quantity: 12,
          unitPrice: 45,
          lineTotal: 540,
          confidence: 'high',
          reviewStatus: 'review_required',
        },
      ],
      contractTotalNet: {
        value: 5070,
        status: 'confirmed',
        confidence: 'high',
      },
    });
    const proposal: ContractOrderProposal = {
      customer: 'Müller Bau GmbH',
      contractor: 'Mustermann Sanitär GmbH',
      constructionSite: 'Hauptstr. 12',
      positionCount: 1,
      contractTotalNet: '5.070,00 €',
      paymentTermsSummary: '14 Tage',
      reviewHints: [],
      positions: intelligence.positions,
      intelligence,
    };

    const beforeCount = vorgangService.getAllVorgaenge().length;
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
      contractOrderProposal: proposal,
      suggestedOrderPositions: intelligence.positions.map(
        ({ sourcePage: _s, confidence: _c, reviewStatus: _r, ...pos }) => pos,
      ),
    });

    expect(result.readOnly).toBe(true);
    expect(['possible_new_business_case', 'contract_proposed', 'review_required']).toContain(
      result.meaning.eventType,
    );
    expect(result.meaning.eventType).toBe('possible_new_business_case');
    expect(result.effects.some((e) => e.kind === 'contract')).toBe(true);
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(true);
    expect(result.effects.some((e) => e.kind === 'money')).toBe(true);
    expect(result.requiredConfirmations.some((c) => c.id === 'confirm_positions')).toBe(true);
    expect(result.requiredConfirmations.some((c) => c.id === 'confirm_contract_parties')).toBe(
      true,
    );
    expect(result.facts.positions.length).toBe(1);
    expect(result.facts.positions[0]?.description).toMatch(/Fliesen/i);
    expect(result.facts.positions[0]?.quantity).toBe(12);
    expect(result.facts.parties.counterparty?.name).toMatch(/Müller/i);
    expect(createSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(taskSpy).not.toHaveBeenCalled();
    expect(vorgangService.getAllVorgaenge()).toHaveLength(beforeCount);
  });

  it('2) Eingangsrechnung erzeugt keine Vertrags- oder Auftragswirkung', () => {
    const item = baseInbox({
      id: 'inbox-bbi-invoice',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Großhandel Nord',
      recognizedData: {
        Betrag: '120,00 €',
        Faelligkeit: '2026-08-01',
        Lieferant: 'Großhandel Nord',
      },
    });

    const result = interpret(item, {
      classifiedKind: 'eingangsrechnung',
      classificationConfidence: 'high',
      documentUnderstanding: {
        documentType: 'eingangsrechnung',
        sender: 'Großhandel Nord',
        amount: '120,00 €',
        deadline: '2026-08-01',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });

    expect(result.meaning.eventType).toBe('invoice_received');
    expect(result.effects.some((e) => e.kind === 'contract')).toBe(false);
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(false);
    expect(result.effects.some((e) => e.kind === 'money' || e.kind === 'invoice')).toBe(true);
    expect(result.requiredConfirmations.some((c) => c.id === 'finalize_invoice')).toBe(true);
  });

  it('3) Lieferschein verändert keine vorhandene Planmenge', () => {
    const vorgang = createTestVorgang({
      id: 'v-bbi-delivery',
      orderPositions: [
        {
          id: 'op-1',
          description: 'Rohre',
          plannedQuantity: 10,
          unit: 'Meter',
          unitPrice: 5,
          category: 'material',
        },
      ],
    });
    hydrateVorgangStore([vorgang]);
    const appendSpy = vi.spyOn(vorgangService, 'appendOrderPositionsBulk');

    const item = baseInbox({
      id: 'inbox-bbi-ls',
      classifiedKind: 'lieferschein',
      documentType: 'sonstiges',
      vorgangId: vorgang.id,
      recognizedData: { Menge: '4', Lieferant: 'Rohr AG' },
    });

    const result = interpret(
      item,
      {
        classifiedKind: 'lieferschein',
        classificationConfidence: 'high',
      },
      vorgang,
    );

    expect(result.meaning.eventType).toBe('delivery_recorded');
    expect(result.effects.some((e) => e.kind === 'material')).toBe(true);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(vorgangService.getVorgangById(vorgang.id)?.orderPositions[0]?.plannedQuantity).toBe(10);
  });

  it('4) Nachtrag bei gelocktem Plan ist bestätigungspflichtig und wird nicht angewendet', () => {
    const locked = createTestVorgang({
      id: 'v-bbi-locked',
      customer: 'Isobautec GmbH',
      contractConfirmation: {
        id: 'cc-1',
        confirmedAt: '2026-07-01T10:00:00.000Z',
        customer: 'Isobautec GmbH',
        title: 'Bestätigt',
        positions: [
          {
            id: 'op-1',
            description: 'Dämmung',
            plannedQuantity: 20,
            unit: 'm²',
            unitPrice: 40,
          },
        ],
        negotiation: {
          notes: [],
          generalHints: [],
          priceProposals: [],
          positionProposals: [],
          drafts: [],
        },
        immutable: true,
      },
    });

    const appendSpy = vi.spyOn(vorgangService, 'appendOrderPositionsBulk');
    const item = baseInbox({
      id: 'inbox-bbi-nachtrag',
      classifiedKind: 'nachtrag',
      documentType: 'kundenauftrag',
      vorgangId: locked.id,
    });

    const result = interpret(
      item,
      {
        classifiedKind: 'nachtrag',
        classificationConfidence: 'high',
        suggestedVorgang: {
          vorgangId: locked.id,
          vorgangTitle: locked.title,
          customer: locked.customer,
          confidence: 'high',
          reasonKey: 'match',
        },
      },
      locked,
    );

    expect(result.meaning.eventType).toBe('service_change_proposed');
    expect(result.conflicts.some((c) => c.id === 'locked_plan_amendment')).toBe(true);
    expect(result.requiredConfirmations.some((c) => c.id === 'confirm_amendment')).toBe(true);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(locked.orderPositions[0]?.plannedQuantity).toBe(10);
  });

  it('5) Unsicheres Dokument erzeugt keine erfundene Ereignisart', () => {
    const item = baseInbox({
      id: 'inbox-bbi-uncertain',
      classifiedKind: 'sonstiges',
      documentType: 'sonstiges',
      title: 'Unklar.pdf',
    });

    const result = interpret(item, {
      classifiedKind: 'sonstiges',
      classificationConfidence: 'low',
      documentUnderstanding: {
        documentType: 'sonstiges',
        nextStep: 'Prüfen',
        partialRecognition: true,
        kindReviewRequired: true,
      },
    });

    expect(result.meaning.eventType).toBe('review_required');
    expect(result.meaning.certainty).toBe('uncertain');
    expect(result.meaning.alternativeEventTypes).toEqual([]);
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(false);
  });

  it('6) Bestehende Next Actions werden nicht doppelt neu erzeugt', () => {
    const item = baseInbox({ id: 'inbox-bbi-next' });
    const nextActions: WorkflowNextAction[] = [
      { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
      { id: 'link_vorgang', labelKey: 'intake.action.linkVorgang', enabled: true },
      { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
      { id: 'cancel', labelKey: 'intake.action.cancel', enabled: true },
    ];

    const result = interpret(item, {
      nextActions,
      suggestedTasks: [
        {
          title: 'Dokument prüfen',
          description: 'x',
          priority: 'mittel',
          category: 'dokumente',
          sourceType: 'inbox',
          taskKind: 'review',
          dedupeKey: 'task-1',
        },
      ],
    });

    const workflowCandidates = result.nextActionCandidates.filter(
      (c) => c.source === 'workflow.nextActions',
    );
    const ids = workflowCandidates.map((c) => c.id);
    expect(ids).toEqual(['archive_document', 'link_vorgang', 'cancel']);
    expect(result.nextActionCandidates.length).toBeLessThanOrEqual(5);
    expect(result.nextActionCandidates.length).toBeLessThanOrEqual(
      3 + 1, // deduped nextActions + one task
    );
  });

  it('7) Spezialisten-Ergebnisse bleiben unverändert (keine Mutation)', () => {
    const item = baseInbox({ classifiedKind: 'eingangsrechnung', documentType: 'eingangsrechnung' });
    const core = workflowCore(item, {
      classifiedKind: 'eingangsrechnung',
      nextActions: [
        { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
        { id: 'cancel', labelKey: 'intake.action.cancel', enabled: true },
      ],
    });
    const snapshot = JSON.stringify(core);
    interpretBusinessFromWorkflow({ item, workflow: core, linkedVorgang: null });
    expect(JSON.stringify(core)).toBe(snapshot);
  });

  it('8) Read-only Koordination ruft keine Persistenz-/Ausführungs-Services auf', () => {
    const spies = [
      vi.spyOn(vorgangService, 'createVorgangFromInbox'),
      vi.spyOn(vorgangService, 'appendOrderPositionsBulk'),
      vi.spyOn(vorgangService, 'linkInboxToExistingVorgang'),
      vi.spyOn(taskEngineService, 'createTasksFromProposals'),
    ];

    const item = baseInbox({
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    interpret(item, {
      classifiedKind: 'werkvertrag',
      contractOrderProposal: {
        customer: 'A',
        contractor: 'B',
        constructionSite: 'C',
        positionCount: 0,
        paymentTermsSummary: '',
        reviewHints: [],
        positions: [],
        intelligence: emptyIntelligence(),
      },
    });

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('9a) Werkvertrag kann Auftragswirkung (Leistungsplan) vorschlagen', () => {
    const item = baseInbox({ classifiedKind: 'werkvertrag' });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      positions: [
        {
          description: 'Pos 1',
          unit: 'm²',
          quantity: 1,
          unitPrice: 10,
          lineTotal: 10,
          confidence: 'medium',
          reviewStatus: 'review_required',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
      contractOrderProposal: {
        customer: 'K',
        contractor: 'A',
        constructionSite: 'S',
        positionCount: 1,
        paymentTermsSummary: '',
        reviewHints: [],
        positions: intelligence.positions,
        intelligence,
      },
    });
    expect(result.contractFamily).toBe('werkvertrag');
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(true);
  });

  it('9b) Mietvertrag darf keinen falschen Leistungsplan vorschlagen', () => {
    const item = baseInbox({ classifiedKind: 'leasingvertrag' });
    const intelligence = emptyIntelligence({
      classifiedKind: 'leasingvertrag',
      documentLabelKey: 'documentIntelligence.label.mietvertrag',
      contractType: {
        family: 'mietvertrag',
        labelKey: 'documentIntelligence.label.mietvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      // Stray positions must not become Bau-LV for rent.
      positions: [
        {
          description: 'Schein-LV',
          unit: 'm²',
          quantity: 1,
          unitPrice: 1,
          lineTotal: 1,
          confidence: 'low',
          reviewStatus: 'review_required',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'leasingvertrag',
      contractIntelligence: intelligence,
      contractOrderProposal: {
        customer: 'Vermieter',
        contractor: 'Mieter',
        constructionSite: '',
        positionCount: 1,
        paymentTermsSummary: '',
        reviewHints: [],
        positions: intelligence.positions,
        intelligence,
      },
    });
    expect(result.contractFamily).toBe('mietvertrag');
    expect(result.effects.some((e) => e.kind === 'contract')).toBe(true);
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(false);
    expect(result.requiredConfirmations.some((c) => c.id === 'confirm_positions')).toBe(false);
  });

  it('9c) Wartungsvertrag darf kein Bau-LV erfinden', () => {
    const item = baseInbox({ classifiedKind: 'werkvertrag' });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'wartungsvertrag',
        labelKey: 'documentIntelligence.label.wartungsvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      positions: [],
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
      contractOrderProposal: {
        customer: 'Kunde',
        contractor: 'Wartung GmbH',
        constructionSite: '',
        positionCount: 0,
        paymentTermsSummary: '',
        reviewHints: [],
        positions: [],
        intelligence,
      },
    });
    expect(result.contractFamily).toBe('wartungsvertrag');
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(false);
  });

  it('Mahnung → payment_reminder_received ohne Kommunikation', () => {
    const item = baseInbox({
      classifiedKind: 'mahnung',
      documentType: 'brief',
      recognizedData: { Betrag: '500 €', Faelligkeit: '2026-07-30' },
    });
    const result = interpret(item, {
      classifiedKind: 'mahnung',
      classificationConfidence: 'high',
      documentUnderstanding: {
        documentType: 'mahnung',
        amount: '500 €',
        deadline: '2026-07-30',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });
    expect(result.meaning.eventType).toBe('payment_reminder_received');
    expect(result.effects.some((e) => e.kind === 'deadline' || e.kind === 'money')).toBe(true);
  });

  it('Integration: processUploadedDocument liefert businessInterpretation read-only', () => {
    const createSpy = vi.spyOn(vorgangService, 'createVorgangFromInbox');
    const item = baseInbox({
      id: 'inbox-bbi-integration',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      title: 'Werkvertrag Mustermann Sanitär GmbH Müller',
      recognizedData: {
        _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);
    hydrateVorgangStore([]);

    const workflow = processUploadedDocument(item.id);
    expect(workflow).not.toBeNull();
    expect(workflow!.businessInterpretation).not.toBeNull();
    expect(workflow!.businessInterpretation!.readOnly).toBe(true);
    expect(workflow!.businessInterpretation!.sourceDocument.sourceDocumentId).toBe(item.id);
    expect(workflow!.businessInterpretation!.facts).toBeTruthy();
    expect(createSpy).not.toHaveBeenCalled();
    expect(vorgangService.getAllVorgaenge()).toHaveLength(0);
  });
});

describe('BUSINESS-BRAIN-01A1 — structured facts + intake safety', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    hydrateInboxStore([]);
    vi.restoreAllMocks();
  });

  function interpretFromFixture(item: InboxItem) {
    const text = String(item.recognizedData._vertragstext ?? item.recognizedData._extractedText ?? '');
    const pages = item.recognizedData._pageTexts
      ? (JSON.parse(String(item.recognizedData._pageTexts)) as ReturnType<
          typeof buildSyntheticWerkvertragPages
        >)
      : undefined;
    const intelligence = text.trim()
      ? analyzeContractIntelligenceFromText(text, pages)
      : null;
    const proposal = intelligence ? buildContractOrderProposal(item, intelligence) : null;
    const core = workflowCore(item, {
      classifiedKind:
        intelligence?.classifiedKind ?? item.classifiedKind ?? 'sonstiges',
      classificationConfidence: 'high',
      companyRelevant: true,
      contractIntelligence: intelligence,
      contractOrderProposal: proposal,
      contractAnalysis: null,
      suggestedOrderPositions: (intelligence?.positions ?? []).map(
        ({ sourcePage: _s, confidence: _c, reviewStatus: _r, ...position }) => position,
      ),
      documentUnderstanding: {
        documentType: item.classifiedKind ?? item.documentType,
        amount: item.recognizedData.Betrag,
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
      nextActions: [
        { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
        { id: 'cancel', labelKey: 'intake.action.cancel', enabled: true },
      ],
    });
    return interpretBusinessFromWorkflow({ item, workflow: core, linkedVorgang: null });
  }

  it('A) Referenz-Werkvertrag: strukturierte Parteien, Ort, Geld, Positionen, Bedingungen', () => {
    const text = buildSyntheticWerkvertragText();
    const pages = buildSyntheticWerkvertragPages();
    const item = baseInbox({
      id: 'inbox-bbi01a1-werk',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      markedAsCompanyDocument: true,
      title: 'Werkvertrag Isobautec',
      recognizedData: {
        _vertragstext: text,
        _extractedText: text,
        _pageTexts: JSON.stringify(pages),
        Betreff: 'Vertrag',
        Kunde: 'Isobautec GmbH',
      },
    });

    const bi = interpretFromFixture(item);
    const facts = bi.facts;

    expect(facts.parties.counterparty?.name).toMatch(/Isobautec/i);
    const ownOrOther =
      facts.parties.ownCompany?.name ??
      facts.parties.others.find((party) => /Iliev|Ivan/i.test(party.name))?.name;
    expect(ownOrOther).toMatch(/Iliev|Ivan/i);
    expect(facts.subject.site?.value || facts.subject.project?.value).toBeTruthy();
    expect(facts.subject.site?.value ?? facts.subject.project?.value ?? '').toMatch(
      /Möhnetal|Rüthen|Sägewerk|Fisch|Abdichtung/i,
    );
    expect(facts.money.length).toBeGreaterThan(0);
    const total = facts.money.find((m) => m.kind === 'contract_total' || m.kind === 'boq_total');
    expect(total).toBeTruthy();
    if (total?.kind === 'boq_total') {
      expect(total.label ?? '').toMatch(/nicht ausdrücklich als Vertragssumme/i);
    }
    expect(facts.positions.length).toBeGreaterThan(3);
    expect(facts.positions.some((p) => /PVC-Folie/i.test(p.description) && p.quantity)).toBe(true);
    expect(facts.positions.every((p) => Boolean(p.description))).toBe(true);
    expect(facts.conditions.some((c) => c.type === 'hourly_work')).toBe(true);
    expect(facts.conditions.some((c) => c.type === 'waiting_time')).toBe(true);
    expect(
      facts.conditions.some((c) =>
        ['payment_terms', 'warranty', 'contractual_penalty', 'bg_bau', 'soka_bau', 'acceptance'].includes(
          c.type,
        ),
      ),
    ).toBe(true);
  });

  it('B) Wartungsvertrag: keine Baupositionen, Pauschale/Intervall nur aus Spezialist', () => {
    const text = `
Wartungsvertrag
Auftraggeber: Nord Technik AG
Dienstleister: Klima Service GmbH
Vertragsdatum: 10.01.2026
Vertragsgegenstand: Wartung der Klimaanlagen
Laufzeit: 24 Monate
Pauschale: 450,00 € monatlich
Reaktionszeit: 24 Stunden
Kündigungsfrist: 3 Monate zum Laufzeitende
Automatische Verlängerung: um 12 Monate
Zahlungsbedingungen: monatlich im Voraus
`.trim();
    const item = baseInbox({
      id: 'inbox-bbi01a1-wartung',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      markedAsCompanyDocument: true,
      recognizedData: {
        _vertragstext: text,
        _extractedText: text,
        Betreff: 'Wartungsvertrag',
      },
    });
    const bi = interpretFromFixture(item);
    expect(bi.contractFamily).toBe('wartungsvertrag');
    expect(bi.facts.positions).toHaveLength(0);
    expect(bi.effects.some((e) => e.kind === 'performance')).toBe(false);
    if (bi.facts.money.some((m) => m.kind === 'recurring_fee')) {
      expect(bi.facts.money.find((m) => m.kind === 'recurring_fee')?.amountFormatted).toMatch(/450/);
    }
    expect(
      bi.facts.timeline.duration ||
        bi.facts.conditions.some((c) => c.type === 'service_interval' || c.type === 'reaction_time'),
    ).toBeTruthy();
  });

  it('C) Mietvertrag: Objekt/Miete/Laufzeit, keine OrderPositions', () => {
    const text = `
Mietvertrag
Vermieter: Haus & Hof GmbH
Mieter: Büro Partner UG
Vertragsdatum: 01.02.2026
Mietobjekt: Bürofläche Am Markt 3, 44135 Dortmund
Mietbeginn: 01.03.2026
Laufzeit: 36 Monate
Kaltmiete: 1.850,00 €
Nebenkosten: 320,00 €
Kaution: 5.550,00 €
Kündigungsfrist: 6 Monate zum Monatsende
`.trim();
    const item = baseInbox({
      id: 'inbox-bbi01a1-miete',
      classifiedKind: 'leasingvertrag',
      documentType: 'kundenauftrag',
      markedAsCompanyDocument: true,
      recognizedData: {
        _vertragstext: text,
        _extractedText: text,
        Betreff: 'Mietvertrag',
      },
    });
    const bi = interpretFromFixture(item);
    expect(bi.contractFamily).toBe('mietvertrag');
    expect(bi.facts.positions).toHaveLength(0);
    expect(bi.effects.some((e) => e.kind === 'performance')).toBe(false);
    expect(bi.facts.subject.object?.value ?? '').toMatch(/Dortmund|Markt/i);
    expect(bi.facts.money.some((m) => m.kind === 'rent')).toBe(true);
    expect(bi.facts.timeline.duration?.value ?? bi.facts.timeline.start?.value).toBeTruthy();
  });

  it('D) Rechnung: Geldkennzahl, keine Vertragsleistungen/Bauklauseln', () => {
    const item = baseInbox({
      id: 'inbox-bbi01a1-invoice',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      markedAsCompanyDocument: true,
      recognizedData: {
        _extractedText: SAMPLE_EINGANGSRECHNUNG_TEXT,
        Betrag: '1.475,60 €',
        Rechnungsnummer: 'RE-2026-9912',
      },
    });
    const bi = interpretFromFixture(item);
    expect(bi.meaning.eventType).toBe('invoice_received');
    expect(bi.facts.money.some((m) => m.kind === 'invoice_total')).toBe(true);
    expect(bi.facts.positions).toHaveLength(0);
    expect(bi.facts.conditions.some((c) => c.type === 'bg_bau' || c.type === 'hourly_work')).toBe(
      false,
    );
  });

  it('E) Unsicher: review_required, keine erfundenen Parteien/Leistungen', () => {
    const item = baseInbox({
      id: 'inbox-bbi01a1-unsicher',
      classifiedKind: 'sonstiges',
      documentType: 'sonstiges',
      recognizedData: {
        _extractedText: 'Seite mit unlesbarem Textfragment xyz 123',
        Betreff: 'Unklar',
      },
    });
    const bi = interpretFromFixture(item);
    expect(bi.meaning.eventType).toBe('review_required');
    expect(bi.facts.positions).toHaveLength(0);
    expect(bi.facts.parties.counterparty).toBeUndefined();
    expect(bi.facts.money).toHaveLength(0);
  });

  it('F) Fehlerisolation: Interpretation wirft, Intake bleibt gültig', () => {
    vi.spyOn(businessInterpretationService, 'interpretBusinessFromWorkflow').mockImplementation(
      () => {
        throw new Error('simulated business interpretation failure');
      },
    );

    const item = baseInbox({
      id: 'inbox-bbi01a1-isolation',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      markedAsCompanyDocument: true,
      recognizedData: {
        _extractedText: SAMPLE_EINGANGSRECHNUNG_TEXT,
        Betrag: '10 €',
      },
    });
    hydrateInboxStore([item]);
    const createSpy = vi.spyOn(vorgangService, 'createVorgangFromInbox');

    const workflow = processUploadedDocument(item.id);
    expect(workflow).not.toBeNull();
    expect(workflow!.classifiedKind).toBeTruthy();
    expect(workflow!.businessInterpretation).toBeNull();
    expect(workflow!.warnings.some((w) => w.id === 'business_interpretation_failed')).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('G) structured facts mutieren Spezialisten nicht', () => {
    const text = buildSyntheticWerkvertragText();
    const pages = buildSyntheticWerkvertragPages();
    const item = baseInbox({
      id: 'inbox-bbi01a1-nomut',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      markedAsCompanyDocument: true,
      recognizedData: {
        _vertragstext: text,
        _extractedText: text,
        _pageTexts: JSON.stringify(pages),
      },
    });
    const intelligence = analyzeContractIntelligenceFromText(text, pages);
    const proposal = buildContractOrderProposal(item, intelligence);
    const core = workflowCore(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
      contractOrderProposal: proposal,
    });
    const before = JSON.stringify({ intelligence, proposal });
    const bi = interpretBusinessFromWorkflow({ item, workflow: core, linkedVorgang: null });
    expect(bi.facts.positions.length).toBeGreaterThan(0);
    expect(JSON.stringify({ intelligence, proposal })).toBe(before);
  });
});

describe('BUSINESS-BRAIN-01A1-FIX-01 Schutztests', () => {
  beforeEach(() => {
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    hydrateInboxStore([]);
  });

  it('1) Rechnung mit CI-Vertragssumme: kein contract_total, kein Contract-Effect, keine Positionen', () => {
    const item = baseInbox({
      id: 'inbox-fix01-invoice-ci',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      markedAsCompanyDocument: true,
      recognizedData: {
        Betrag: '1.475,60 €',
        Rechnungsnummer: 'RE-FIX-1',
      },
    });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      contractTotalNet: {
        value: 36029.05,
        status: 'confirmed',
        confidence: 'high',
        sourceText: 'Vertragssumme 36.029,05 €',
      },
      positions: [
        {
          description: 'Scheinposition',
          unit: 'Stk',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          confidence: 'high',
          reviewStatus: 'confirmed',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'eingangsrechnung',
      contractIntelligence: intelligence,
      contractOrderProposal: {
        customer: 'Fremd AG',
        contractor: 'Mustermann Sanitär GmbH',
        constructionSite: 'X',
        positionCount: 1,
        contractTotalNet: '36.029,05 €',
        paymentTermsSummary: '',
        reviewHints: [],
        positions: intelligence.positions,
        intelligence,
      },
      documentUnderstanding: {
        documentType: 'eingangsrechnung',
        amount: '1.475,60 €',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });

    expect(result.meaning.eventType).toBe('invoice_received');
    expect(result.facts.money.some((m) => m.kind === 'contract_total')).toBe(false);
    expect(result.facts.money.some((m) => m.kind === 'boq_total')).toBe(false);
    expect(result.effects.some((e) => e.kind === 'contract')).toBe(false);
    expect(result.facts.positions).toHaveLength(0);
    const invoice = result.facts.money.find((m) => m.kind === 'invoice_total');
    expect(invoice?.amountFormatted).toMatch(/1\.?475/);
  });

  it('2) Nur Kündigungsfrist: Condition termination, timeline.deadline leer', () => {
    const item = baseInbox({
      id: 'inbox-fix01-kuendigung',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'dienstleistungsvertrag',
        labelKey: 'documentIntelligence.label.dienstleistungsvertrag',
        confidence: 'medium',
        status: 'confirmed',
        evidence: [],
      },
      commonFields: {
        kuendigungsfrist: {
          value: '3 Monate zum Laufzeitende',
          status: 'confirmed',
          confidence: 'high',
        },
      },
      contractFields: {
        kuendigungsfrist: {
          value: '3 Monate zum Laufzeitende',
          status: 'confirmed',
          confidence: 'high',
        },
      },
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
    });

    expect(result.facts.conditions.some((c) => c.type === 'termination')).toBe(true);
    expect(result.facts.timeline.deadline).toBeUndefined();
  });

  it('3) documentType ist kein Subject', () => {
    const item = baseInbox({
      id: 'inbox-fix01-subject',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
    });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      contractFields: {},
      commonFields: {},
      typeSpecificFields: {},
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
      documentUnderstanding: {
        documentType: 'werkvertrag',
        nextStep: 'Prüfen',
        partialRecognition: true,
      },
    });

    expect(result.facts.subject.subject).toBeUndefined();
    expect(JSON.stringify(result.facts.subject)).not.toMatch(/Werkvertrag/i);
  });

  it('4) Nachtragsklausel ist keine evidence_requirement', () => {
    const item = baseInbox({
      id: 'inbox-fix01-nachtrag',
      classifiedKind: 'werkvertrag',
    });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      clauses: [
        {
          id: 'nachtraege',
          status: 'confirmed',
          confidence: 'high',
          summary: 'Nachträge bedürfen der Schriftform',
          sourceText: 'Nachträge bedürfen der Schriftform',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
    });

    expect(result.facts.conditions.some((c) => c.type === 'evidence_requirement')).toBe(false);
    expect(
      result.facts.conditions.some((c) => /nachweis/i.test(c.summary) && /nachtrag/i.test(c.summary)),
    ).toBe(false);
  });

  it('5a) Werkvertrag: AG = Gegenpartei, AN nur bei belastbarer Zuordnung', () => {
    const item = baseInbox({ classifiedKind: 'werkvertrag' });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      parties: [
        {
          role: 'auftraggeber',
          name: 'Bauherr AG',
          status: 'confirmed',
          confidence: 'high',
        },
        {
          role: 'auftragnehmer',
          name: 'Mustermann Sanitär GmbH',
          status: 'confirmed',
          confidence: 'high',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
      contractOrderProposal: {
        customer: 'Bauherr AG',
        contractor: 'Mustermann Sanitär GmbH',
        constructionSite: 'Ort',
        positionCount: 0,
        paymentTermsSummary: '',
        reviewHints: [],
        positions: [],
        intelligence,
      },
    });

    expect(result.facts.parties.counterparty?.name).toMatch(/Bauherr/i);
    expect(result.facts.parties.counterparty?.relation).toBe('counterparty');
    expect(result.facts.parties.ownCompany?.name).toMatch(/Mustermann/i);
  });

  it('5b) Kaufvertrag ohne Company-Match: Rollen erhalten, keine erfundene Seite', () => {
    const item = baseInbox({ classifiedKind: 'kaufvertrag' });
    const intelligence = emptyIntelligence({
      classifiedKind: 'kaufvertrag',
      documentLabelKey: 'documentIntelligence.label.kaufvertrag',
      contractType: {
        family: 'kaufvertrag',
        labelKey: 'documentIntelligence.label.kaufvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      parties: [
        {
          role: 'kaeufer',
          name: 'Einkauf Partner GmbH',
          status: 'confirmed',
          confidence: 'high',
        },
        {
          role: 'verkaeufer',
          name: 'Verkauf Handel AG',
          status: 'confirmed',
          confidence: 'high',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'kaufvertrag',
      contractIntelligence: intelligence,
    });

    expect(result.facts.parties.counterparty).toBeUndefined();
    expect(result.facts.parties.ownCompany).toBeUndefined();
    const roles = result.facts.parties.others.map((p) => p.role);
    expect(roles).toContain('kaeufer');
    expect(roles).toContain('verkaeufer');
    expect(result.facts.parties.others.every((p) => p.relation === 'other')).toBe(true);
  });

  it('6) Unbekannte Familie: keine Positionen, kein Performance-Effect', () => {
    const item = baseInbox({ classifiedKind: 'sonstiges' });
    const intelligence = emptyIntelligence({
      classifiedKind: 'sonstiges',
      // family intentionally omitted → undefined
      positions: [
        {
          description: 'Zufallsposition',
          unit: 'Stk',
          quantity: 2,
          unitPrice: 50,
          lineTotal: 100,
          confidence: 'medium',
          reviewStatus: 'review_required',
        },
      ],
    });
    const result = interpret(item, {
      classifiedKind: 'sonstiges',
      contractIntelligence: intelligence,
      suggestedOrderPositions: intelligence.positions.map(
        ({ sourcePage: _s, confidence: _c, reviewStatus: _r, ...pos }) => pos,
      ),
      contractOrderProposal: {
        customer: 'X',
        contractor: 'Y',
        constructionSite: '',
        positionCount: 1,
        paymentTermsSummary: '',
        reviewHints: ['prüfen'],
        positions: intelligence.positions,
        intelligence,
      },
    });

    expect(result.contractFamily).toBeUndefined();
    expect(result.facts.positions).toHaveLength(0);
    expect(result.effects.some((e) => e.kind === 'performance')).toBe(false);
  });

  it('7a) Betrag ohne Währung → keine erfundene Währung', () => {
    const item = baseInbox({
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: { Betrag: '1475.60' },
    });
    const result = interpret(item, {
      classifiedKind: 'eingangsrechnung',
      documentUnderstanding: {
        documentType: 'eingangsrechnung',
        amount: '1475.60',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });
    const invoice = result.facts.money.find((m) => m.kind === 'invoice_total');
    expect(invoice?.amount).toBeCloseTo(1475.6, 1);
    expect(invoice?.currency).toBeUndefined();
  });

  it('7b) Betrag mit EUR-Quelle → EUR bleibt', () => {
    const item = baseInbox({
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: { Betrag: '1.475,60 €' },
    });
    const result = interpret(item, {
      classifiedKind: 'eingangsrechnung',
      documentUnderstanding: {
        documentType: 'eingangsrechnung',
        amount: '1.475,60 €',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });
    expect(result.facts.money.find((m) => m.kind === 'invoice_total')?.currency).toBe('EUR');
  });

  it('8a) Gleichwertige Formatvarianten erzeugen keinen Geldkonflikt', () => {
    const item = baseInbox({ classifiedKind: 'werkvertrag' });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      contractFields: {
        stundenlohn: {
          value: '36.029,05 €',
          status: 'confirmed',
          confidence: 'high',
        },
        stundenverrechnungssatz: {
          value: '36029.05',
          status: 'confirmed',
          confidence: 'high',
        },
      },
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
    });

    expect(
      result.conflicts.some((c) => c.id.startsWith('money_') || /geld/i.test(c.summary)),
    ).toBe(false);
  });

  it('8b) Gleiche Geldart mit echter numerischer Differenz → Konflikt', () => {
    const item = baseInbox({ classifiedKind: 'werkvertrag' });
    const intelligence = emptyIntelligence({
      contractType: {
        family: 'werkvertrag',
        labelKey: 'documentIntelligence.label.werkvertrag',
        confidence: 'high',
        status: 'confirmed',
        evidence: [],
      },
      contractFields: {
        stundenlohn: {
          value: '36,50 €',
          status: 'confirmed',
          confidence: 'high',
        },
        stundenverrechnungssatz: {
          value: '40,00 €',
          status: 'confirmed',
          confidence: 'high',
        },
      },
    });
    const result = interpret(item, {
      classifiedKind: 'werkvertrag',
      contractIntelligence: intelligence,
    });

    expect(result.conflicts.some((c) => c.id === 'money_same_kind_mismatch_hourly_rate')).toBe(
      true,
    );
  });
});

describe('BUSINESS-MEANING-CORE-01 — shared operational reading', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    hydrateInboxStore([]);
    vi.restoreAllMocks();
  });

  it('FA: authority_documents_required + document_submission_due', () => {
    const item = baseInbox({
      id: 'inbox-meaning-fa',
      classifiedKind: 'finanzamt',
      title: 'Finanzamt Unterlagen',
      sender: 'Finanzamt Berlin',
      recognizedData: {
        _extractedText: `Finanzamt Berlin
wir bitten um Einreichung der folgenden Unterlagen bis zum 15.04.2026:
- Umsatzsteuervoranmeldung
Eine Antwort bzw. Einreichung ist fristgebunden erforderlich.`,
      },
    });
    const result = interpret(item, {
      classifiedKind: 'finanzamt',
      documentUnderstanding: {
        documentType: 'finanzamt',
        deadline: '15.04.2026',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });
    expect(result.operational.primaryCase).toBe('authority_documents_required');
    expect(result.operational.deadlineType).toBe('document_submission_due');
    expect(result.operational.meanings).toEqual(
      expect.arrayContaining(['obligation', 'evidence', 'deadline', 'action_required']),
    );
    expect(result.operational.nextStep.toLowerCase()).toMatch(/unterlagen/);
    expect(result.operational.confirmRequirement.length).toBeGreaterThan(0);
  });

  it('Versicherung: insurance_contribution despite Schadenfall aside', () => {
    const item = baseInbox({
      id: 'inbox-meaning-vs',
      classifiedKind: 'versicherung',
      title: 'Beitragsanpassung',
      sender: 'Handwerk Versicherung AG',
      recognizedData: {
        _extractedText: `Beitragsanpassung ab 01.05.2026
Neuer Jahresbeitrag: 1.280,00 €
Bei Rückfragen zu einem Schadenfall reichen Sie Unterlagen nach.
Keine automatische Lastschriftänderung.`,
      },
    });
    const result = interpret(item, { classifiedKind: 'versicherung' });
    expect(result.operational.primaryCase).toBe('insurance_contribution');
    expect(result.operational.meanings).toEqual(
      expect.arrayContaining(['money', 'action_required']),
    );
    expect(result.operational.nextStep).toMatch(/keine automatische Zahlung/i);
  });

  it('Bank: bank_payment_problem', () => {
    const item = baseInbox({
      id: 'inbox-meaning-bank',
      classifiedKind: 'kontoauszug',
      title: 'Rücklastschrift',
      sender: 'Sparkasse Berlin',
      recognizedData: {
        _extractedText: `Mitteilung: Rücklastschrift / Zahlungsstörung
Grund: unzureichende Deckung
Es erfolgt keine automatische erneute Zahlung.`,
      },
    });
    const result = interpret(item, { classifiedKind: 'kontoauszug' });
    expect(result.operational.primaryCase).toBe('bank_payment_problem');
    expect(result.operational.meanings).toEqual(
      expect.arrayContaining(['money', 'risk', 'action_required']),
    );
  });

  it('Hotel: expense_hotel', () => {
    const item = baseInbox({
      id: 'inbox-meaning-hotel',
      classifiedKind: 'eingangsrechnung',
      title: 'Hotelrechnung City Lodge',
      recognizedData: {
        _extractedText: `Hotelrechnung
Hotel: City Lodge Berlin
Übernachtung EZ
Betrag: 278,80 €`,
        Betrag: '278,80 €',
      },
    });
    const result = interpret(item, {
      classifiedKind: 'eingangsrechnung',
      documentUnderstanding: {
        documentType: 'eingangsrechnung',
        amount: '278,80 €',
        nextStep: 'Prüfen',
        partialRecognition: false,
      },
    });
    expect(result.meaning.eventType).toBe('invoice_received');
    expect(result.operational.primaryCase).toBe('expense_hotel');
    expect(result.operational.nextStep).toMatch(/Betriebsausgabe/i);
  });

  it('Mail: communication_schedule_change + service_due', () => {
    const item = baseInbox({
      id: 'inbox-meaning-mail',
      classifiedKind: 'brief',
      importSource: 'email',
      title: 'Terminverschiebung',
      sender: 'kunde@mueller-bau.example',
      recognizedData: {
        _extractedText: `können wir unseren Termin vom 28.03.2026 auf den 02.04.2026 verschieben?
Bitte um kurze Rückmeldung per E-Mail.`,
      },
    });
    const result = interpret(item, { classifiedKind: 'brief' });
    expect(result.operational.primaryCase).toBe('communication_schedule_change');
    expect(result.operational.deadlineType).toBe('service_due');
    expect(result.operational.meanings).toEqual(
      expect.arrayContaining(['communication', 'action_required']),
    );
    expect(result.operational.nextStep).toMatch(/nicht automatisch/i);
  });

  it('BG/SOKA text without classified authority kind still yields documents_required', () => {
    const item = baseInbox({
      id: 'inbox-meaning-bg',
      classifiedKind: 'sonstiges',
      title: 'BG BAU Nachweise',
      sender: 'BG BAU',
      recognizedData: {
        _extractedText: `BG BAU – Berufsgenossenschaft
Bitte reichen Sie bis 30.04.2026 ein:
- Unbedenklichkeitsbescheinigung
- SOKA-BAU Meldenachweis`,
      },
    });
    const result = interpret(item, { classifiedKind: 'sonstiges' });
    expect(result.meaning.eventType).toBe('deadline_or_obligation_detected');
    expect(result.operational.primaryCase).toBe('authority_documents_required');
    expect(result.operational.deadlineType).toBe('document_submission_due');
  });
});
