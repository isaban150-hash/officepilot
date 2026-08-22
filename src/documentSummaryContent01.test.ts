/**
 * DOCUMENT-SUMMARY-CONTENT-01 — fact priority, truncation, site/project/positions.
 */
import { describe, expect, it } from 'vitest';
import { t, type TranslationKey } from './i18n';
import {
  buildDocumentSummary,
  buildInboxDocumentSummary,
  createInboxWorkflowStub,
} from './services/documentSummary';
import {
  CONTRACT_SUMMARY_FACT_ORDER,
  DOCUMENT_SUMMARY_FACT_MAX_CHARS,
  formatPositionsFactValue,
  preferProjectFactValue,
  shortenConstructionSiteFact,
  truncateSummaryFactText,
} from './services/documentSummaryContent';
import { createAuftragInboxItem } from './test/fixtures';
import type { ContractIntelligenceResult, ContractOrderProposal } from './types/documentIntelligence';

function translate(key: TranslationKey): string {
  return t(key, 'de');
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
      bauvorhaben: {
        value: 'Dachsanierung Wohnanlage Möhnesee – Bauabschnitt Nord mit langer Zusatzbeschreibung',
        status: 'confirmed',
        confidence: 'high',
      },
      baustelle: {
        value: 'Isobautec GmbH\nMöhnetal 55\n59519 Möhnesee\nDeutschland',
        status: 'confirmed',
        confidence: 'high',
      },
      vertragsgegenstand: {
        value:
          'Gemäß den nachstehenden Vertragsgrundlagen und allgemeinen Geschäftsbedingungen ' +
          'übernimmt der Auftragnehmer die vollständige Dachsanierung einschließlich Dämmung, ' +
          'Abdichtung und Entsorgung gemäß Leistungsverzeichnis Anlage 1.',
        status: 'confirmed',
        confidence: 'medium',
      },
    },
    positions: Array.from({ length: 11 }, (_, i) => ({
      positionNumber: String(i + 1),
      description: `Lange Leistungsbeschreibung Position ${i + 1} mit vielen Details`,
      unit: 'qm',
      quantity: 10,
      unitPrice: 10,
      lineTotal: 100,
      confidence: 'high' as const,
      reviewStatus: 'confirmed' as const,
    })),
    parties: [
      { role: 'auftraggeber', name: 'Isobautec GmbH', status: 'confirmed', confidence: 'high' },
      { role: 'auftragnehmer', name: 'Mustermann', status: 'confirmed', confidence: 'high' },
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
    constructionSite: 'Isobautec GmbH\nMöhnetal 55\n59519 Möhnesee\nDeutschland',
    positionCount: 11,
    contractTotalNet: '12.000,00 €',
    paymentTermsSummary: '30 Tage',
    reviewHints: [],
    positions: intelligence.positions,
    intelligence,
  };
}

describe('DOCUMENT-SUMMARY-CONTENT-01', () => {
  it('kürzt lange Fact-Texte auf max. ~2 Zeilen mit …', () => {
    const long =
      'Dies ist ein sehr langer Projekttext mit vielen Details zur Ausführung und ' +
      'zusätzlichen Hinweisen die auf dem ersten Bildschirm keinen Platz haben sollen';
    const short = truncateSummaryFactText(long);
    expect(short.endsWith('…')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_FACT_MAX_CHARS);
    expect(short).not.toContain('\n');
  });

  it('kürzt Baustellenadressen auf Straße und Ort', () => {
    const shortened = shortenConstructionSiteFact(
      'Isobautec GmbH\nMöhnetal 55\n59519 Möhnesee\nDeutschland',
    );
    expect(shortened).toContain('Möhnetal 55');
    expect(shortened).toContain('Möhnesee');
    expect(shortened).not.toContain('Deutschland');
    expect(shortened.split('\n')).toHaveLength(1);
  });

  it('preferiert Bauvorhaben statt langer Vertragsgegenstand-Prosa', () => {
    const project = preferProjectFactValue(
      'Dachsanierung Nord',
      'Gemäß den nachstehenden Vertragsgrundlagen übernimmt der Auftragnehmer die komplette Leistung …',
    );
    expect(project).toBe('Dachsanierung Nord');

    const fromProseOnly = preferProjectFactValue(
      'Gemäß den nachstehenden Vertragsgrundlagen und allgemeinen Geschäftsbedingungen ' +
        'übernimmt der Auftragnehmer die vollständige Dachsanierung einschließlich Dämmung.',
    );
    expect(fromProseOnly?.endsWith('…')).toBe(true);
  });

  it('formatiert Positionsanzahl statt Leistungsbeschreibung', () => {
    expect(formatPositionsFactValue('11', (n) => `${n} Positionen erkannt`)).toBe(
      '11 Positionen erkannt',
    );
    expect(formatPositionsFactValue('11 Positionen', (n) => `${n} Positionen erkannt`)).toBe(
      '11 Positionen erkannt',
    );
    expect(
      formatPositionsFactValue(
        'Dachabdichtung einschließlich Dämmung und Entsorgung gemäß LV',
        (n) => `${n} Positionen erkannt`,
      ),
    ).toBeUndefined();
  });

  it('Werkvertrag detail: Facts-Reihenfolge + Summe/Positionen/Baustelle', () => {
    const item = createAuftragInboxItem({
      id: 'content-wv',
      classifiedKind: 'werkvertrag',
      recognizedData: {
        Auftraggeber: 'Ignore-RD',
        Vertragsgegenstand: 'Langer Vertragstext der nicht als Projekt dienen soll',
      },
    });
    const summary = buildDocumentSummary(item, null, {
      translate,
      proposal: buildProposal(),
    });

    expect(summary.headline).toBe('Werkvertrag');
    expect(summary.headline).not.toBe('Neuer Auftrag');
    expect(summary.subtitle).toContain('Isobautec');
    expect(summary.subtitle).toMatch(/Dachsanierung/);

    const ids = summary.facts.map((f) => f.id);
    expect(ids).toEqual(CONTRACT_SUMMARY_FACT_ORDER.filter((id) => ids.includes(id)));

    const orderValueIdx = ids.indexOf('orderValue');
    const siteIdx = ids.indexOf('site');
    expect(orderValueIdx).toBeGreaterThanOrEqual(0);
    expect(siteIdx).toBeGreaterThan(orderValueIdx);

    expect(summary.facts.find((f) => f.id === 'orderValue')?.value).toContain('12.000');
    expect(summary.facts.find((f) => f.id === 'positions')?.value).toBe('11 Positionen erkannt');
    expect(summary.facts.find((f) => f.id === 'site')?.value).toContain('Möhnetal 55');
    expect(summary.facts.find((f) => f.id === 'site')?.value).not.toContain('Deutschland');
    expect(summary.facts.find((f) => f.id === 'project')?.value).toMatch(/Dachsanierung/);
    expect(summary.facts.find((f) => f.id === 'project')?.value).not.toMatch(/Vertragsgrundlagen/);

    for (const fact of summary.facts) {
      expect(fact.value.split('\n')).toHaveLength(1);
      expect(fact.value.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_FACT_MAX_CHARS);
    }

    const service = summary.details.find((d) => d.id === 'service');
    expect(service?.proseText && service.proseText.length).toBeGreaterThan(40);
  });

  it('Inbox/Dashboard: dieselbe Fact-Reihenfolge und Kürzung', () => {
    const item = createAuftragInboxItem({
      id: 'content-inbox-wv',
      classifiedKind: 'werkvertrag',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Bauvorhaben:
          'Sehr langes Bauvorhaben mit vielen zusätzlichen Erläuterungen und Hinweisen die gekürzt werden müssen für die Karte',
        Baustelle: 'Musterstraße 12\n12345 Berlin\nDeutschland',
        Vertragssumme: '8.500,00 €',
        'Anzahl Positionen': '11',
        Positionen: 'Lange Leistungsbeschreibung die nicht erscheinen darf',
        Gewerk: 'Dachdecker',
        Vertragsgegenstand:
          'Gemäß den nachstehenden Vertragsgrundlagen übernimmt der Auftragnehmer sämtliche Leistungen.',
      },
    });

    const summary = buildInboxDocumentSummary(item, { translate });
    const ids = summary.facts.map((f) => f.id);
    expect(ids).toEqual(CONTRACT_SUMMARY_FACT_ORDER.filter((id) => ids.includes(id)));
    expect(ids.indexOf('orderValue')).toBeLessThan(ids.indexOf('site'));
    expect(summary.facts.find((f) => f.id === 'orderValue')?.value).toContain('8.500');
    expect(summary.facts.find((f) => f.id === 'positions')?.value).toBe('11 Positionen erkannt');
    expect(summary.facts.find((f) => f.id === 'site')?.value).toContain('Musterstraße 12');
    expect(summary.facts.find((f) => f.id === 'site')?.value).toContain('Berlin');
    expect(summary.facts.find((f) => f.id === 'project')?.value.endsWith('…')).toBe(true);
    expect(summary.headline).toBe('Werkvertrag');

    for (const fact of summary.facts) {
      expect(fact.value.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_FACT_MAX_CHARS);
    }
  });

  /*
   * DOCUMENT-BELEGNUMMER-CONSISTENCY-01 — der Stub-Consumer las bisher nur
   * `Rechnungsnummer` und lieferte für Belegarten `undefined`, während die
   * Belegtatsache in derselben Datei bereits über `rd()` beide Schreibweisen
   * berücksichtigte.
   */
  it('G: der Stub liefert für Belege denselben Identifikator wie die Belegtatsache', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-summary-beleg',
      documentType: 'eingangsrechnung',
      classifiedKind: 'tankbeleg',
      sender: 'Testtankstelle Musterstadt',
      title: 'Tankbeleg',
      recognizedData: { Betrag: '70,51', Belegnummer: 'TEST-000184' },
    });

    const stub = createInboxWorkflowStub(item);
    // Bisher `undefined`, weil nur `Rechnungsnummer` gelesen wurde.
    expect(stub.documentUnderstanding?.invoiceNumber).toBe('TEST-000184');
    // Derselbe Wert, den die Belegtatsache in dieser Datei bereits nennt.
    expect(stub.documentUnderstanding?.invoiceNumber).toBe(
      item.recognizedData.Belegnummer,
    );
  });

  it('G2: bei beiden Feldern gewinnt auch im Stub die Rechnungsnummer', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-summary-beide',
      documentType: 'eingangsrechnung',
      classifiedKind: 'eingangsrechnung',
      sender: 'Baustoff Müller',
      recognizedData: { Rechnungsnummer: 'R-2026-77', Belegnummer: 'TEST-000184' },
    });

    expect(createInboxWorkflowStub(item).documentUnderstanding?.invoiceNumber).toBe('R-2026-77');
  });
});
