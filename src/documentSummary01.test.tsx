/**
 * DOCUMENT-SUMMARY-IMPLEMENTATION-01 — buildDocumentSummary + Experience Card limits.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { t, type TranslationKey } from './i18n';
import { DocumentExperienceCard } from './components/inbox/review/DocumentExperienceCard';
import { DocumentReviewExperience } from './components/inbox/review/DocumentReviewExperience';
import { buildDocumentSummary, resolveDocumentSummaryFamily } from './services/documentSummary';
import { getLetterExplanation } from './services/letterExplanationService';
import { createAuftragInboxItem } from './test/fixtures';
import type { BusinessInterpretationResult } from './types/businessInterpretation';
import type { ContractIntelligenceResult, ContractOrderProposal } from './types/documentIntelligence';
import type { InboxItem, WorkflowResult } from './types/models';
import {
  DOCUMENT_SUMMARY_MAX_ALERTS,
  DOCUMENT_SUMMARY_MAX_FACTS,
  DOCUMENT_SUMMARY_MAX_SECONDARY,
} from './types/documentSummary';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function minimalBi(
  kind: InboxItem['classifiedKind'],
  overrides: Partial<BusinessInterpretationResult> = {},
): BusinessInterpretationResult {
  return {
    readOnly: true,
    sourceDocument: {
      sourceDocumentId: 'doc-1',
      classifiedKind: kind ?? 'sonstiges',
      classificationConfidence: 'medium',
      recognitionUncertain: false,
    },
    meaning: {
      eventType: 'information_only',
      certainty: 'detected',
      summary: 'Test',
      alternativeEventTypes: [],
    },
    operational: {
      primaryCase: 'review_required',
      meanings: ['information', 'review'],
      nextStep: 'Bitte prüfen.',
      confirmRequirement: 'Angaben bestätigen',
      certainty: 'detected',
    },
    vorgangRef: { status: 'none', similarCount: 0 },
    parties: [],
    effects: [],
    missingInformation: [],
    conflicts: [],
    requiredConfirmations: [],
    nextActionCandidates: [],
    facts: {
      parties: { others: [] },
      subject: {},
      timeline: {},
      money: [],
      positions: [],
      conditions: [],
      signatures: { status: 'not_detected', certainty: 'uncertain', source: 'recognizedData' },
    },
    derivedFrom: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: true,
      hasDocumentUnderstanding: true,
      companyRelevant: true,
    },
    ...overrides,
  };
}

function workflowFor(item: InboxItem, bi: BusinessInterpretationResult): WorkflowResult {
  return {
    classifiedKind: item.classifiedKind ?? 'sonstiges',
    companyRelevant: true,
    companyRelevance: {
      status: 'company',
      reasonKey: 'companyRelevance.reason.companyDocument',
      matchedSignals: [],
    },
    documentUnderstanding: {
      documentType: item.classifiedKind ?? 'sonstiges',
      sender: item.sender,
      recipient: item.recognizedData.Empfänger,
      date: item.recognizedData.Datum,
      referenceNumber: item.recognizedData.Aktenzeichen ?? item.recognizedData.Rechnungsnummer,
      constructionSite: item.recognizedData.Baustelle,
      customer: item.recognizedData.Kunde,
      invoiceNumber: item.recognizedData.Rechnungsnummer,
      amount: item.recognizedData.Betrag,
      deadline: item.deadline ?? item.recognizedData.Frist,
      nextStep: 'Prüfen',
      partialRecognition: false,
    },
    classification: null,
    businessInterpretation: bi,
    contractIntelligence: null,
    contractOrderProposal: null,
    contractAnalysis: null,
    suggestedVorgang: null,
    suggestedOrderPositions: [],
    suggestedTasks: [],
    nextActions: [],
    documentExplanation: null,
    documentAiActions: [],
  } as unknown as WorkflowResult;
}

function assertCardLimits(summary: ReturnType<typeof buildDocumentSummary>) {
  expect(summary.facts.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAX_FACTS);
  expect(summary.alerts.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAX_ALERTS);
  expect(summary.primaryAction).toBeTruthy();
  expect(summary.secondaryActions.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAX_SECONDARY);
}

function buildProposal(): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [2],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {
      auftraggeber: { value: 'Isobautec GmbH', status: 'confirmed', confidence: 'high' },
      bauvorhaben: { value: 'Dachsanierung', status: 'confirmed', confidence: 'high' },
      baustelle: { value: 'Möhnetal 55', status: 'confirmed', confidence: 'high' },
    },
    positions: Array.from({ length: 3 }, (_, i) => ({
      positionNumber: String(i + 1),
      description: `Pos ${i + 1}`,
      unit: 'qm',
      quantity: 10,
      unitPrice: 10,
      lineTotal: 100,
      confidence: 'high' as const,
      reviewStatus: 'confirmed' as const,
    })),
    parties: [
      { role: 'auftraggeber', name: 'Isobautec GmbH' },
      { role: 'auftragnehmer', name: 'Mustermann' },
    ],
    contractTotalNet: {
      value: 12000,
      status: 'confirmed',
      confidence: 'high',
      sourceText: '12.000,00 €',
    },
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Mustermann',
    constructionSite: 'Möhnetal 55',
    positionCount: 3,
    contractTotalNet: '12.000,00 €',
    reviewHints: [],
    positions: intelligence.positions,
    intelligence,
  };
}

describe('DOCUMENT-SUMMARY-IMPLEMENTATION-01', () => {
  it('Werkvertrag: Summary aus Proposal/CI; Caps eingehalten', () => {
    const item = createAuftragInboxItem({
      id: 'sum-wv',
      classifiedKind: 'werkvertrag',
      recognizedData: { Auftraggeber: 'RD-Kunde-Falsch' },
    });
    const proposal = buildProposal();
    const summary = buildDocumentSummary(item, null, { translate, proposal });
    expect(summary.family).toBe('contract');
    expect(summary.hasDeepWorkspace).toBe(true);
    expect(summary.facts.some((f) => f.id === 'customer' && f.value.includes('Isobautec'))).toBe(
      true,
    );
    expect(summary.primaryAction.id).toBe('accept_contract_order');
    assertCardLimits(summary);

    const html = renderToStaticMarkup(
      createElement(DocumentExperienceCard, {
        summary,
        translate,
        onAction: () => undefined,
      }),
    );
    expect(html).toContain('Isobautec GmbH');
    expect(html).toContain('data-testid="document-experience-primary"');
  });

  it('Eingangsrechnung: Understanding/RD-Fakten; eine Primäraktion', () => {
    const item = createAuftragInboxItem({
      id: 'sum-er',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: {
        Lieferant: 'Baumarkt GmbH',
        Rechnungsnummer: 'RE-1',
        Betrag: '100,00 €',
        Datum: '01.04.2026',
      },
    });
    const workflow = workflowFor(item, minimalBi('eingangsrechnung'));
    expect(resolveDocumentSummaryFamily(item, workflow)).toBe('invoice_in');
    const summary = buildDocumentSummary(item, workflow, { translate });
    assertCardLimits(summary);
    // VORGANG-INTELLIGENCE: presentation primary follows case match (none → create).
    expect(summary.primaryAction.id).toBe('create_vorgang');
    expect(summary.caseMatch?.matchStatus).toBe('none');
    expect(summary.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['supplier', 'invoiceNumber', 'amount', 'date']),
    );
  });

  it('Tankbeleg', () => {
    const item = createAuftragInboxItem({
      id: 'sum-tank',
      classifiedKind: 'tankbeleg',
      recognizedData: { Tankstelle: 'ARAL', Betrag: '50,00 €', Datum: '01.01.2026' },
    });
    const summary = buildDocumentSummary(item, workflowFor(item, minimalBi('tankbeleg')), {
      translate,
    });
    expect(summary.family).toBe('tank');
    assertCardLimits(summary);
    expect(summary.facts.some((f) => f.id === 'station')).toBe(true);
  });

  it('Behördenbrief + Brief', () => {
    const authority = createAuftragInboxItem({
      id: 'sum-fa',
      classifiedKind: 'finanzamt',
      documentType: 'behoerde',
      sender: 'Finanzamt',
      deadline: '15.04.2026',
      title: 'Erinnerung',
      recognizedData: {
        Absender: 'Finanzamt',
        Betreff: 'USt',
        Aktenzeichen: 'FA-1',
        Frist: '15.04.2026',
      },
    });
    const letter = getLetterExplanation(authority, 'de');
    const authoritySummary = buildDocumentSummary(
      authority,
      workflowFor(authority, minimalBi('finanzamt')),
      { translate, letter },
    );
    expect(authoritySummary.family).toBe('authority');
    assertCardLimits(authoritySummary);

    const brief = createAuftragInboxItem({
      id: 'sum-brief',
      classifiedKind: 'brief',
      documentType: 'brief',
      sender: 'Partner AG',
      recognizedData: { Absender: 'Partner AG', Betreff: 'Abstimmung' },
    });
    const briefSummary = buildDocumentSummary(brief, workflowFor(brief, minimalBi('brief')), {
      translate,
      letter: getLetterExplanation(brief, 'de'),
    });
    expect(briefSummary.family).toBe('letter');
    assertCardLimits(briefSummary);
  });

  it('Lieferschein + Angebot', () => {
    const ls = createAuftragInboxItem({
      id: 'sum-ls',
      classifiedKind: 'lieferschein',
      recognizedData: { Lieferant: 'GH', Datum: '01.03.2026', Baustelle: 'Ort 1' },
    });
    const lsSummary = buildDocumentSummary(ls, workflowFor(ls, minimalBi('lieferschein')), {
      translate,
    });
    expect(lsSummary.family).toBe('delivery');
    expect(lsSummary.alerts.some((a) => a.id === 'delivery-qty')).toBe(true);
    assertCardLimits(lsSummary);

    const offer = createAuftragInboxItem({
      id: 'sum-offer',
      classifiedKind: 'angebot',
      recognizedData: { Kunde: 'Kunde AG', Betrag: '1.000,00 €' },
    });
    const offerSummary = buildDocumentSummary(offer, workflowFor(offer, minimalBi('angebot')), {
      translate,
    });
    expect(offerSummary.family).toBe('offer');
    expect(offerSummary.primaryAction.id).toBe('create_vorgang');
    assertCardLimits(offerSummary);
  });

  it('Review Experience rendert First Screen nur aus DocumentSummary', () => {
    const item = createAuftragInboxItem({
      id: 'sum-ui',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: {
        Lieferant: 'Lieferant X',
        Rechnungsnummer: 'R-9',
        Betrag: '9,00 €',
      },
    });
    const workflow = workflowFor(item, minimalBi('eingangsrechnung'));
    const html = renderToStaticMarkup(
      createElement(DocumentReviewExperience, {
        item,
        workflow,
        moreOptionsExpanded: false,
        onToggleMoreOptions: () => undefined,
        onApplySuggestion: () => undefined,
        onNextDocument: () => undefined,
        moreOptionsContent: null,
        translate,
      }),
    );
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).toContain('Lieferant X');
    expect(html).not.toContain('data-testid="operational-overview"');
  });

  it('Priorität: Understanding-Betrag vor BI-Geld', () => {
    const item = createAuftragInboxItem({
      id: 'sum-prio',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: {},
    });
    const bi = minimalBi('eingangsrechnung', {
      facts: {
        parties: { others: [] },
        subject: {},
        timeline: {},
        money: [
          {
            kind: 'invoice_total',
            amount: 999,
            amountFormatted: '999,00 €',
            currency: 'EUR',
            certainty: 'detected',
            source: 'recognizedData',
          },
        ],
        positions: [],
        conditions: [],
        signatures: { status: 'not_detected', certainty: 'uncertain', source: 'recognizedData' },
      },
    });
    const workflow = workflowFor(item, bi);
    workflow.documentUnderstanding = {
      ...workflow.documentUnderstanding!,
      amount: '111,00 €',
    };
    const summary = buildDocumentSummary(item, workflow, { translate });
    const amount = summary.facts.find((f) => f.id === 'amount')?.value;
    expect(amount).toBe('111,00 €');
  });
});
