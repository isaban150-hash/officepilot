/**
 * VORGANG-INTELLIGENCE-01 — deterministic DocumentCaseMatch + presentation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentExperienceCard } from './components/inbox/review/DocumentExperienceCard';
import { t, type TranslationKey } from './i18n';
import {
  buildDocumentCaseMatch,
  extractDocumentCaseSignals,
} from './services/documentCaseMatchService';
import {
  buildDocumentSummary,
  buildInboxDocumentSummary,
  createInboxWorkflowStub,
} from './services/documentSummary';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore, getAllVorgaenge, getVorgangById } from './services/vorgangService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { BusinessInterpretationResult } from './types/businessInterpretation';
import type { InboxItem, WorkflowResult } from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function minimalBi(kind: InboxItem['classifiedKind']): BusinessInterpretationResult {
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
      nextStep: 'Prüfen',
      confirmRequirement: 'Bestätigen',
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
  };
}

function workflowFor(item: InboxItem, bi: BusinessInterpretationResult): WorkflowResult {
  const stub = createInboxWorkflowStub(item);
  return {
    ...stub,
    businessInterpretation: bi,
    companyRelevant: true,
  };
}

describe('VORGANG-INTELLIGENCE-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('exact: bekannte Verknüpfung + Kunde/Baustelle', () => {
    const vorgang = createTestVorgang({
      id: 'v-exact',
      title: 'Sägewerk Ernst Flisch',
      customer: 'Ernst Flisch',
      baustelle: 'Werkstraße 1',
    });
    hydrateVorgangStore([vorgang]);
    const item = createAuftragInboxItem({
      id: 'inbox-exact',
      classifiedKind: 'werkvertrag',
      vorgangId: 'v-exact',
      recognizedData: {
        Auftraggeber: 'Ernst Flisch',
        Baustelle: 'Werkstraße 1',
        Bauvorhaben: 'Sägewerk Ernst Flisch',
      },
    });

    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.matchedCaseId).toBe('v-exact');
    expect(match.matchedCaseTitle).toBe('Sägewerk Ernst Flisch');
    expect(match.reasons).toEqual(expect.arrayContaining(['known_link']));

    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.caseMatch?.matchStatus).toBe('exact');
    expect(summary.primaryAction.id).toBe('open_vorgang');
    expect(summary.primaryAction.labelKey).toBe('documentExperience.action.openCase');

    const html = renderToStaticMarkup(
      createElement(DocumentExperienceCard, {
        summary,
        translate,
        onAction: () => undefined,
      }),
    );
    expect(html).toContain('Passender Vorgang gefunden');
    expect(html).toContain('Sägewerk Ernst Flisch');
    expect(html).toContain('bereits verknüpft');
    expect(html).not.toMatch(/%|Prozent|0\.\d{2}/);
  });

  it('exact: Kunde + Baustelle ohne bekannte Verknüpfung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-site-cust',
        title: 'Dachsanierung Nord',
        customer: 'Isobautec GmbH',
        baustelle: 'Möhnetal 55',
      }),
    ]);
    const item = createAuftragInboxItem({
      id: 'inbox-site-cust',
      classifiedKind: 'werkvertrag',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Baustelle: 'Möhnetal 55',
      },
    });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.matchedCaseId).toBe('v-site-cust');
    expect(match.reasons).toEqual(
      expect.arrayContaining(['same_customer', 'same_site']),
    );
  });

  it('likely: nur Kunde → likely', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-cust',
        title: 'Auftrag A',
        customer: 'Isobautec GmbH',
        baustelle: 'Andere Straße 9',
      }),
    ]);
    const item = createAuftragInboxItem({
      id: 'inbox-cust-only',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Lieferant: 'Baumarkt GmbH',
        Rechnungsnummer: 'RE-1',
      },
    });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('likely');
    expect(match.matchedCaseId).toBe('v-cust');
    expect(match.reasons).toContain('same_customer');

    const summary = buildDocumentSummary(item, workflowFor(item, minimalBi('eingangsrechnung')), {
      translate,
    });
    expect(summary.primaryAction.id).toBe('link_vorgang');
    expect(summary.primaryAction.labelKey).toBe('vorgangIntelligence.action.assign');
  });

  it('multiple: mehrere gleich starke Treffer', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-a',
        title: 'Projekt West',
        customer: 'Isobautec GmbH',
        baustelle: 'West 1',
      }),
      createTestVorgang({
        id: 'v-b',
        title: 'Projekt Ost',
        customer: 'Isobautec GmbH',
        baustelle: 'Ost 2',
      }),
    ]);
    const item = createAuftragInboxItem({
      id: 'inbox-multi',
      classifiedKind: 'lieferschein',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Lieferant: 'GH',
      },
    });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('multiple');
    expect(match.matchedCaseId).toBeNull();
    expect(match.candidates.length).toBeGreaterThanOrEqual(2);

    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.primaryAction.id).toBe('select_vorgang');
    const html = renderToStaticMarkup(
      createElement(DocumentExperienceCard, {
        summary,
        translate,
        onAction: () => undefined,
      }),
    );
    expect(html).toContain('Mehrere passende Vorgänge');
    expect(html).toContain('Projekt West');
    expect(html).toContain('Projekt Ost');
  });

  it('none: kein Treffer', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-other',
        title: 'Komplett anders',
        customer: 'Fremdfirma AG',
        baustelle: 'Nirgendwo 1',
      }),
    ]);
    const item = createAuftragInboxItem({
      id: 'inbox-none',
      classifiedKind: 'tankbeleg',
      recognizedData: { Tankstelle: 'ARAL', Betrag: '40 €' },
      sender: 'ARAL',
    });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('none');
    expect(match.matchedCaseId).toBeNull();

    const summary = buildDocumentSummary(item, workflowFor(item, minimalBi('tankbeleg')), {
      translate,
    });
    expect(summary.caseMatch?.matchStatus).toBe('none');
    expect(summary.primaryAction.id).toBe('create_vorgang');
    expect(summary.primaryAction.labelKey).toBe('vorgangIntelligence.action.create');
  });

  it('Familien: Werkvertrag, Rechnung, Lieferschein, Tank, Behörde, Brief', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-shared',
        title: 'Gemeinsamer Vorgang',
        customer: 'Musterkunde',
        baustelle: 'Baustelle 7',
      }),
    ]);

    const cases: Array<{ kind: InboxItem['classifiedKind']; rd: Record<string, string> }> = [
      {
        kind: 'werkvertrag',
        rd: { Auftraggeber: 'Musterkunde', Baustelle: 'Baustelle 7', Bauvorhaben: 'Gemeinsamer Vorgang' },
      },
      {
        kind: 'eingangsrechnung',
        rd: { Auftraggeber: 'Musterkunde', Baustelle: 'Baustelle 7', Rechnungsnummer: 'X-1' },
      },
      {
        kind: 'lieferschein',
        rd: { Auftraggeber: 'Musterkunde', Baustelle: 'Baustelle 7' },
      },
      {
        kind: 'brief',
        rd: { Kunde: 'Musterkunde', Betreff: 'Gemeinsamer Vorgang', Baustelle: 'Baustelle 7' },
      },
      {
        kind: 'finanzamt',
        rd: {
          Absender: 'Finanzamt',
          Auftraggeber: 'Musterkunde',
          Baustelle: 'Baustelle 7',
          Betreff: 'Erinnerung',
          Aktenzeichen: 'AZ-1',
        },
      },
    ];

    for (const entry of cases) {
      const item = createAuftragInboxItem({
        id: `fam-${entry.kind}`,
        classifiedKind: entry.kind,
        recognizedData: entry.rd,
        sender: entry.rd.Absender ?? 'Sender',
      });
      const match = buildDocumentCaseMatch(item);
      expect(match.matchStatus, entry.kind).not.toBe('none');
      expect(match.matchedCaseId ?? match.candidates[0]?.caseId).toBe('v-shared');
    }

    const tank = createAuftragInboxItem({
      id: 'fam-tank',
      classifiedKind: 'tankbeleg',
      recognizedData: { Tankstelle: 'Shell', Betrag: '10' },
      sender: 'Shell',
    });
    expect(buildDocumentCaseMatch(tank).matchStatus).toBe('none');

    // Behördenbrief ohne Kunden-/Baustellen-Signal → none (nur Betreff ist zu schwach)
    const authorityNone = createAuftragInboxItem({
      id: 'fam-fa-none',
      classifiedKind: 'finanzamt',
      recognizedData: {
        Absender: 'Finanzamt',
        Betreff: 'USt-Voranmeldung',
        Aktenzeichen: 'FA-99',
      },
      sender: 'Finanzamt',
    });
    expect(buildDocumentCaseMatch(authorityNone).matchStatus).toBe('none');
  });

  it('ändert Domain nicht und speichert nichts', () => {
    const before = getAllVorgaenge();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-immutable',
        title: 'Unverändert',
        customer: 'Kunde X',
        baustelle: 'Ort X',
      }),
    ]);
    const snapshot = structuredClone(getVorgangById('v-immutable'));
    const item = createAuftragInboxItem({
      id: 'inbox-immutable',
      classifiedKind: 'werkvertrag',
      recognizedData: { Auftraggeber: 'Kunde X', Baustelle: 'Ort X' },
    });
    hydrateInboxStore([item]);

    buildDocumentCaseMatch(item);
    buildInboxDocumentSummary(item, { translate });
    buildDocumentSummary(item, workflowFor(item, minimalBi('werkvertrag')), { translate });

    expect(getVorgangById('v-immutable')).toEqual(snapshot);
    expect(getAllVorgaenge().map((v) => v.id)).toEqual(['v-immutable']);
    expect(before.every((v) => getVorgangById(v.id))).toBe(true);
    expect(sessionStorage.getItem('officepilot-document-case-match')).toBeNull();
    expect(localStorage.getItem('officepilot-document-case-match')).toBeNull();
  });

  it('Signals nutzen nur vorhandene Felder (keine neuen Extraktoren)', () => {
    const item = createAuftragInboxItem({
      recognizedData: {
        Bauvorhaben: 'Projekt A',
        Baustelle: 'Ort B',
        Auftraggeber: 'Kunde C',
        Vertragsnummer: 'V-9',
        Rechnungsnummer: 'R-1',
        Lieferant: 'Liefer D',
        Betreff: 'Betreff E',
        Aktenzeichen: 'AZ-2',
      },
    });
    const signals = extractDocumentCaseSignals(item);
    expect(signals.project).toBe('Projekt A');
    expect(signals.site).toBe('Ort B');
    expect(signals.customer).toBe('Kunde C');
    expect(signals.contractNumber).toBe('V-9');
    expect(signals.invoiceNumber).toBe('R-1');
    expect(signals.supplier).toBe('Liefer D');
    expect(signals.subject).toBe('Betreff E');
    expect(signals.reference).toBe('AZ-2');
  });
});
