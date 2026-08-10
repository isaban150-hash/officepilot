/**
 * CONTRACT-REVIEW-UI-01A — echter Renderpfad.
 *
 * buildContractWorkspaceSummaryView() -> ContractWorkspaceSummary.tsx -> HTML.
 * Ein reiner Adaptertest reicht nicht: hier wird der tatsächlich gerenderte
 * Komponentenbaum auf durchgerutschten Klauseltext geprüft.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { t, type TranslationKey } from './i18n';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  ExtractedContractField,
} from './types/documentIntelligence';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function field(value: string): ExtractedContractField {
  return { value, status: 'confirmed', confidence: 'high' };
}

/** Realistische Handy-Fall-Werte: Datumskern + angehängter Vertragsabsatz. */
const BEGINN_RAW =
  '31.08.2026 Geplantes Ausführungsende: 18.09.2026 Zwischentermine werden mit der Bauleitung ' +
  'abgestimmt. Änderungen des Bauablaufs sind frühzeitig mitzuteilen. § 7 Behinderungen und ' +
  'Unterbrechungen Behinderungen, fehlende Vorleistungen oder sonstige Umstände sind ' +
  'unverzüglich anzuzeigen.';

const ENDE_RAW =
  '18.09.2026 Zwischentermine werden mit der Bauleitung abgestimmt. Änderungen des Bauablaufs ' +
  'sind frühzeitig mitzuteilen. § 7 Behinderungen und Unterbrechungen Behinderungen, fehlende ' +
  'Vorleistungen oder sonstige Umstände sind unverzüglich anzuzeigen.';

const ZAHLUNGSBEDINGUNGEN = '14 Kalendertage nach Rechnungseingang';
const GEWAEHRLEISTUNG = '4 Jahre ab Abnahme';
const BAUSTELLE = 'Carl-Bertelsmann-Straße 211, 33335 Gütersloh';
const VERTRAGSDATUM = '09.08.2026';

function buildProposal(): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {
      auftraggeber: field('Isobautec GmbH'),
      auftragnehmer: field('Ivan Iliev'),
      baustelle: field(BAUSTELLE),
      vertragsdatum: field(VERTRAGSDATUM),
      beginn: field(BEGINN_RAW),
      ende: field(ENDE_RAW),
      zahlungsbedingungen: field(ZAHLUNGSBEDINGUNGEN),
      gewaehrleistung: field(GEWAEHRLEISTUNG),
    },
    positions: [],
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Ivan Iliev',
    constructionSite: BAUSTELLE,
    positionCount: 0,
    paymentTermsSummary: '',
    reviewHints: [],
    positions: [],
    intelligence,
  };
}

function renderSummary(proposal: ContractOrderProposal): string {
  return renderToStaticMarkup(
    createElement(ContractWorkspaceSummary, { proposal, translate }),
  );
}

/** Sichtbarer Text ohne Markup — so liest es auch der Nutzer auf dem Handy. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Wert einer gerenderten Zeile anhand ihrer data-testid. */
function renderedRowValue(html: string, testId: string): string | null {
  const start = html.indexOf(`data-testid="${testId}"`);
  if (start < 0) return null;
  const openTagEnd = html.indexOf('>', start);
  // Zeilen sind flache Container; bis zum nächsten gleichrangigen Marker lesen.
  const rest = html.slice(openTagEnd + 1);
  const nextTestId = rest.indexOf('data-testid="');
  const chunk = nextTestId < 0 ? rest : rest.slice(0, nextTestId);
  return visibleText(chunk);
}

describe('CONTRACT-REVIEW-UI-01A – gerendertes ContractWorkspaceSummary', () => {
  const proposal = buildProposal();
  const view = buildContractWorkspaceSummaryView(proposal);
  const html = renderSummary(proposal);
  const text = visibleText(html);

  it('rendert das Label „Beginn“ mit nur dem Datumskern', () => {
    expect(text).toContain(translate('documentIntelligence.field.startDate'));
    expect(view.deadlineFact?.id).toBe('beginn');
    expect(view.deadlineFact?.value).toBe('31.08.2026');

    const rendered = renderedRowValue(html, 'contract-workspace-summary-beginn');
    expect(rendered).not.toBeNull();
    expect(rendered).toContain('31.08.2026');
    expect(rendered).not.toContain('Zwischentermine');
    expect(rendered).not.toContain('Behinderungen');
  });

  it('rendert das Label „Ende“ mit nur dem Datumskern', () => {
    expect(text).toContain(translate('documentIntelligence.field.endDate'));

    const endeRow = view.factRows.find((row) => row.id === 'ende');
    expect(endeRow?.value).toBe('18.09.2026');

    const rendered = renderedRowValue(html, 'contract-workspace-summary-ende');
    expect(rendered).not.toBeNull();
    expect(rendered).toContain('18.09.2026');
    expect(rendered).not.toContain('Zwischentermine');
    expect(rendered).not.toContain('Behinderungen');
  });

  it('lässt keinen Klauseltext aus den Datumsfeldern in den HTML-Baum', () => {
    expect(text).not.toContain('Behinderungen');
    expect(text).not.toContain('Zwischentermine');
    expect(text).not.toContain('Nachträge');
    expect(text).not.toContain('Bauablauf');
    expect(text).not.toContain('Geplantes Ausführungsende');
  });

  it('zeigt Zahlungsbedingungen und Gewährleistung unverändert', () => {
    expect(text).toContain(ZAHLUNGSBEDINGUNGEN);
    expect(text).toContain(GEWAEHRLEISTUNG);
  });

  it('H: eindeutige Datumswerte erscheinen ohne Prüfhinweis', () => {
    const hinweis = translate('documentIntelligence.workspace.needsReview');

    expect(renderedRowValue(html, 'contract-workspace-summary-beginn')).not.toContain(hinweis);
    expect(renderedRowValue(html, 'contract-workspace-summary-ende')).not.toContain(hinweis);
    expect(view.deadlineFact?.needsReview).toBe(false);
    expect(view.factRows.find((row) => row.id === 'ende')?.needsReview).toBe(false);
  });

  it('zeigt Baustelle und Vertragsdatum weiterhin', () => {
    expect(text).toContain(BAUSTELLE);
    expect(text).toContain(VERTRAGSDATUM);
  });
});
