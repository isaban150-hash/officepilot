/**
 * DOCUMENT-EXPERIENCE-02B — non-contract documents on shared Experience Card.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { t, type TranslationKey } from './i18n';
import { DocumentReviewExperience } from './components/inbox/review/DocumentReviewExperience';
import {
  buildDocumentExperienceView,
  resolveDocumentExperienceFamily,
} from './services/documentExperienceView';
import { getLetterExplanation } from './services/letterExplanationService';
import { createAuftragInboxItem } from './test/fixtures';
import type { InboxItem, WorkflowResult } from './types/models';
import type { BusinessInterpretationResult } from './types/businessInterpretation';

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

function renderExperience(item: InboxItem, workflow: WorkflowResult): string {
  return renderToStaticMarkup(
    createElement(DocumentReviewExperience, {
      item,
      workflow,
      moreOptionsExpanded: false,
      onToggleMoreOptions: () => undefined,
      onApplySuggestion: () => undefined,
      onNextDocument: () => undefined,
      moreOptionsContent: null,
      letterExplanation: getLetterExplanation(item, 'de'),
      experienceDetailsExtra: createElement('div', {
        'data-testid': 'document-experience-guidance',
      }),
      translate,
    }),
  );
}

describe('DOCUMENT-EXPERIENCE-02B', () => {
  it('Eingangsrechnung: Lieferant/Nr/Betrag/Datum/Fällig; kein Primary Case', () => {
    const item = createAuftragInboxItem({
      id: 'dexp-er',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Baumarkt GmbH',
      deadline: '20.04.2026',
      recognizedData: {
        Lieferant: 'Baumarkt GmbH',
        Rechnungsnummer: 'RE-9912',
        Betrag: '1.250,00 €',
        Datum: '01.04.2026',
        Frist: '20.04.2026',
      },
    });
    const bi = minimalBi('eingangsrechnung', {
      operational: {
        primaryCase: 'invoice_received',
        meanings: ['money', 'action_required'],
        nextStep: 'Ausgabe erfassen',
        confirmRequirement: 'Betrag prüfen',
        certainty: 'detected',
      },
      facts: {
        parties: {
          counterparty: {
            name: 'Baumarkt GmbH',
            relation: 'counterparty',
            certainty: 'detected',
            source: 'recognizedData',
          },
          others: [],
        },
        subject: {},
        timeline: {
          deadline: {
            value: '20.04.2026',
            certainty: 'detected',
            source: 'recognizedData',
          },
        },
        money: [
          {
            kind: 'invoice_total',
            amount: 1250,
            amountFormatted: '1.250,00 €',
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
    expect(resolveDocumentExperienceFamily(item, workflow)).toBe('invoice_in');
    const view = buildDocumentExperienceView(item, workflow, { translate });
    expect(view.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['supplier', 'invoiceNumber', 'amount', 'date', 'deadline']),
    );
    expect(view.facts.length).toBeLessThanOrEqual(6);
    expect(view.primaryActionLabel).toBe('Neuen Vorgang anlegen');

    const html = renderExperience(item, workflow);
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).toContain('Baumarkt GmbH');
    expect(html).toContain('RE-9912');
    expect(html).toContain('1.250,00 €');
    expect(html).toContain('Neuen Vorgang anlegen');
    expect(html).not.toContain('data-testid="operational-overview"');
    expect(html).not.toContain('Vorschlag übernehmen');
    expect(html).toContain('data-testid="document-experience-details"');
    expect(html).toContain('data-testid="document-experience-guidance"');
  });

  it('Tankbeleg: Tankstelle/Datum/Betrag; keine review_required-Labels', () => {
    const item = createAuftragInboxItem({
      id: 'dexp-tank',
      classifiedKind: 'tankbeleg',
      documentType: 'sonstiges',
      sender: 'ARAL',
      recognizedData: {
        Tankstelle: 'ARAL Station Nord',
        Datum: '10.03.2026',
        Betrag: '72,40 €',
      },
    });
    const workflow = workflowFor(item, minimalBi('tankbeleg'));
    const view = buildDocumentExperienceView(item, workflow, { translate });
    expect(view.family).toBe('tank');
    expect(view.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['station', 'date', 'amount']),
    );
    expect(view.primaryActionLabel).toBe('Neuen Vorgang anlegen');

    const html = renderExperience(item, workflow);
    expect(html).toContain('ARAL Station Nord');
    expect(html).toContain('72,40 €');
    expect(html).not.toContain('Prüfung erforderlich');
    expect(html).not.toContain('Primärer Fall');
  });

  it('Lieferschein: Mengen-Hinweis wenn Menge fehlt', () => {
    const item = createAuftragInboxItem({
      id: 'dexp-ls',
      classifiedKind: 'lieferschein',
      documentType: 'sonstiges',
      sender: 'Großhandel',
      recognizedData: {
        Lieferant: 'Großhandel AG',
        Datum: '05.03.2026',
        Baustelle: 'Hauptstraße 1',
      },
    });
    const workflow = workflowFor(item, minimalBi('lieferschein'));
    const view = buildDocumentExperienceView(item, workflow, { translate });
    expect(view.family).toBe('delivery');
    expect(view.alerts.some((a) => a.id === 'delivery-qty')).toBe(true);
    expect(view.alerts[0]?.label).toContain('Mengen');

    const html = renderExperience(item, workflow);
    expect(html).toContain('Großhandel AG');
    expect(html).toContain('Hauptstraße 1');
    expect(html).toContain('Gelieferte Mengen konnten nicht erkannt werden.');
  });

  it('Behördenbrief: Letter-Fakten oben; Letter-Panel unter Details', () => {
    const item = createAuftragInboxItem({
      id: 'dexp-fa',
      classifiedKind: 'finanzamt',
      documentType: 'behoerde',
      sender: 'Finanzamt Musterstadt',
      deadline: '15.04.2026',
      priority: 'hoch',
      title: 'Erinnerung Umsatzsteuer',
      recognizedData: {
        Absender: 'Finanzamt Musterstadt',
        Betreff: 'Erinnerung Umsatzsteuer-Voranmeldung',
        Aktenzeichen: 'FA-12/345',
        Frist: '15.04.2026',
      },
    });
    const letter = getLetterExplanation(item, 'de');
    expect(letter).not.toBeNull();
    const workflow = workflowFor(item, minimalBi('finanzamt'));
    const view = buildDocumentExperienceView(item, workflow, { translate, letter });
    expect(view.family).toBe('authority');
    expect(view.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['authority', 'subject', 'reference', 'deadline']),
    );

    const html = renderToStaticMarkup(
      createElement(DocumentReviewExperience, {
        item,
        workflow,
        moreOptionsExpanded: false,
        onToggleMoreOptions: () => undefined,
        onApplySuggestion: () => undefined,
        onNextDocument: () => undefined,
        moreOptionsContent: null,
        letterExplanation: letter,
        experienceDetailsExtra: createElement(
          'div',
          { 'data-testid': 'document-experience-letter' },
          'letter-panel',
        ),
        translate,
      }),
    );
    expect(html).toContain('Finanzamt Musterstadt');
    expect(html).toContain('FA-12/345');
    expect(html).toContain('15.04.2026');
    expect(html).toContain('Neuen Vorgang anlegen');
    expect(html).toContain('data-testid="document-experience-letter"');
    const cardIdx = html.indexOf('data-testid="document-experience-card"');
    const letterIdx = html.indexOf('data-testid="document-experience-letter"');
    const detailsIdx = html.indexOf('data-testid="document-experience-details"');
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(detailsIdx).toBeGreaterThan(cardIdx);
    expect(letterIdx).toBeGreaterThan(detailsIdx);
  });

  it('Angebot: Vorgang anlegen als Primäraktion', () => {
    const item = createAuftragInboxItem({
      id: 'dexp-ang',
      classifiedKind: 'angebot',
      sender: 'Kunde AG',
      recognizedData: {
        Kunde: 'Kunde AG',
        Betrag: '4.800,00 €',
        Betreff: 'Sanierung Bad',
      },
    });
    const workflow = workflowFor(item, minimalBi('angebot'));
    const view = buildDocumentExperienceView(item, workflow, { translate });
    expect(view.family).toBe('offer');
    expect(view.primaryActionLabel).toBe('Neuen Vorgang anlegen');
  });
});
