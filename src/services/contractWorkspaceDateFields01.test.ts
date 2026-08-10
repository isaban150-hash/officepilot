/**
 * CONTRACT-REVIEW-UI-01A — date-like contract fields must never render a clause.
 * View-level normalization only; ContractIntelligenceResult stays untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContractWorkspaceSummaryView,
  isReviewRelevantDateRemainder,
  normalizeDateLikeDisplayValue,
} from './contractWorkspaceSummaryView';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  ExtractedContractField,
} from '../types/documentIntelligence';

const LONG_CLAUSE =
  '31.08.2026 nach Abruf des AG, spätestens 10 Werktage nach Zuschlag; Behinderungen sind unverzüglich in Textform anzuzeigen';

const CLAUSE_WITHOUT_DATE =
  'Die Ausführung erfolgt nach gesondertem Abruf des Auftraggebers, wobei Behinderungen unverzüglich in Textform anzuzeigen sind';

function field(value: string): ExtractedContractField {
  return { value, status: 'confirmed', confidence: 'high' };
}

function buildProposal(
  contractFields: Record<string, ExtractedContractField>,
  overrides?: Partial<ContractOrderProposal>,
): ContractOrderProposal {
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
    contractFields,
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
    constructionSite: 'Möhnetal 55, 59602 Rüthen',
    positionCount: 0,
    paymentTermsSummary: '',
    reviewHints: [],
    positions: [],
    intelligence,
    ...overrides,
  };
}

/** All rows the compact contract view can render a field value in. */
function allRowValues(proposal: ContractOrderProposal): string[] {
  const view = buildContractWorkspaceSummaryView(proposal);
  return [
    ...view.overviewRows,
    ...view.factRows,
    ...view.generalRows,
    ...view.typeSpecificRows,
    ...view.rows,
    ...(view.deadlineFact ? [view.deadlineFact] : []),
    ...(view.objectFact ? [view.objectFact] : []),
  ].map((row) => row.value);
}

function rowById(proposal: ContractOrderProposal, id: string) {
  const view = buildContractWorkspaceSummaryView(proposal);
  return (
    view.factRows.find((row) => row.id === id) ??
    view.generalRows.find((row) => row.id === id) ??
    view.overviewRows.find((row) => row.id === id) ??
    (view.deadlineFact?.id === id ? view.deadlineFact : undefined)
  );
}

/**
 * Ein datumsartiges Feld kann je nach Vertragsart in unterschiedlichen
 * Zeilengruppen landen. Für den Breitentest zählt nur, dass es überhaupt
 * gerendert wird — deshalb zusätzlich als typeSpecificField gesetzt.
 */
function anyDateLikeRow(key: string, value: string) {
  const proposal = buildProposal({ [key]: field(value) });
  proposal.intelligence.typeSpecificFields = { [key]: field(value) };
  const view = buildContractWorkspaceSummaryView(proposal);

  const row = [
    ...view.factRows,
    ...view.generalRows,
    ...view.typeSpecificRows,
    ...view.overviewRows,
    ...(view.deadlineFact ? [view.deadlineFact] : []),
  ].find((entry) => entry.id === key);

  return row ? { value: row.value, needsReview: row.needsReview } : null;
}

describe('CONTRACT-REVIEW-UI-01A – Datumsfelder in der Vertragsansicht', () => {
  it('A: sauberes Beginn-Datum bleibt sichtbar', () => {
    const proposal = buildProposal({ beginn: field('31.08.2026') });

    expect(rowById(proposal, 'beginn')?.value).toBe('31.08.2026');
    expect(rowById(proposal, 'beginn')?.needsReview).toBe(false);
  });

  it('B: sauberes Ende-Datum bleibt sichtbar', () => {
    const proposal = buildProposal({
      beginn: field('01.09.2026'),
      ende: field('18.09.2026'),
    });

    expect(rowById(proposal, 'ende')?.value).toBe('18.09.2026');
  });

  it('B2: Zeitraum bleibt vollständig erhalten', () => {
    const proposal = buildProposal({ beginn: field('01.09.2026 – 15.09.2026') });

    expect(rowById(proposal, 'beginn')?.value).toBe('01.09.2026 – 15.09.2026');
  });

  it('C: Datum + langer Vertragsabsatz zeigt nur den Datumskern', () => {
    const proposal = buildProposal({ beginn: field(LONG_CLAUSE) });

    const row = rowById(proposal, 'beginn');
    expect(row?.value).toBe('31.08.2026');
    // Truncation hides conditions from the source line -> must be flagged.
    expect(row?.needsReview).toBe(true);

    for (const value of allRowValues(proposal)) {
      expect(value).not.toContain('Behinderungen');
      expect(value).not.toContain('spätestens 10 Werktage');
    }
  });

  it('C2: reiner Klauseltext ohne Datum wird in der kompakten View unterdrückt', () => {
    const proposal = buildProposal({ ende: field(CLAUSE_WITHOUT_DATE) });

    expect(rowById(proposal, 'ende')).toBeUndefined();
    for (const value of allRowValues(proposal)) {
      expect(value).not.toContain('Behinderungen');
    }
  });

  it('D: kurze Terminangaben werden nicht verworfen', () => {
    for (const short of ['KW 36/2026', 'nach Abruf', 'nach Vereinbarung']) {
      const proposal = buildProposal({ beginn: field(short) });
      expect(rowById(proposal, 'beginn')?.value).toBe(short);
    }
  });

  it('E: andere Vertragsfelder bleiben unverändert', () => {
    const longPaymentTerms = '14 Tage mit 2 % Skonto oder 30 Tage netto nach Rechnungseingang';
    const proposal = buildProposal({
      beginn: field('01.04.2026'),
      zahlungsbedingungen: field(longPaymentTerms),
      baustelle: field('Möhnetal 55, 59602 Rüthen'),
      gewaehrleistung: field('4 Jahre nach Abnahme gemäß VOB/B'),
    });

    expect(rowById(proposal, 'zahlungsbedingungen')?.value).toBe(longPaymentTerms);
    expect(rowById(proposal, 'gewaehrleistung')?.value).toBe('4 Jahre nach Abnahme gemäß VOB/B');
    const view = buildContractWorkspaceSummaryView(proposal);
    expect(view.objectFact?.value).toBe('Möhnetal 55, 59602 Rüthen');
  });

  it('F: Rohdaten im ContractIntelligenceResult bleiben unangetastet', () => {
    const proposal = buildProposal({ beginn: field(LONG_CLAUSE) });
    buildContractWorkspaceSummaryView(proposal);

    expect(proposal.intelligence.contractFields.beginn?.value).toBe(LONG_CLAUSE);
  });

  it('G: Normalisierung gilt generisch, nicht nur für Werkverträge', () => {
    const proposal = buildProposal({
      mietbeginn: field(LONG_CLAUSE),
      liefertermin: field(CLAUSE_WITHOUT_DATE),
    });
    proposal.intelligence.classifiedKind = 'mietvertrag';

    for (const value of allRowValues(proposal)) {
      expect(value).not.toContain('Behinderungen');
    }
    expect(normalizeDateLikeDisplayValue(LONG_CLAUSE)).toMatchObject({
      value: '31.08.2026',
      truncated: true,
    });
    expect(normalizeDateLikeDisplayValue(CLAUSE_WITHOUT_DATE)).toBeNull();
  });
});

/**
 * CONTRACT-REVIEW-UI-01B — Kürzung allein ist kein Mangel.
 * Nur ein verworfener Vorbehalt macht das Datum prüfbedürftig.
 */
describe('CONTRACT-REVIEW-UI-01B – Review-Status bereinigter Datumsfelder', () => {
  const SICHER: Array<[string, string]> = [
    ['A: sauberes Datum', '31.08.2026'],
    [
      'B: Folgefeld im selben OCR-Absatz',
      '31.08.2026 Geplantes Ausführungsende: 18.09.2026 Zwischentermine werden mit der Bauleitung abgestimmt.',
    ],
    ['C: reiner Folgesatz', '18.09.2026 Zwischentermine werden mit der Bauleitung abgestimmt.'],
  ];

  const UNSICHER: Array<[string, string]> = [
    ['D: Vorbehalt', '01.04.2026 vorbehaltlich Freigabe durch den Auftraggeber'],
    ['E: Fristbedingung', '01.04.2026 spätestens 10 Werktage nach Zuschlag'],
    ['F: Alternative', '01.04.2026 bzw. nach Baufortschritt'],
  ];

  it.each(SICHER)('%s: Datum bleibt ohne Prüfhinweis', (_name, raw) => {
    const proposal = buildProposal({ beginn: field(raw) });
    const row = rowById(proposal, 'beginn');

    expect(row?.value).toBe(raw.slice(0, 10));
    expect(row?.needsReview).toBe(false);
  });

  it.each(UNSICHER)('%s: Datum bleibt prüfbedürftig', (_name, raw) => {
    const proposal = buildProposal({ beginn: field(raw) });
    const row = rowById(proposal, 'beginn');

    expect(row?.value).toBe('01.04.2026');
    expect(row?.needsReview).toBe(true);
  });

  it('G: reiner Klauseltext ohne Datum bleibt unterdrückt', () => {
    const proposal = buildProposal({ ende: field(CLAUSE_WITHOUT_DATE) });

    expect(rowById(proposal, 'ende')).toBeUndefined();
  });

  it('I: Regel gilt für alle datumsartigen Felder, nicht nur beginn/ende', () => {
    const keys = ['vertragsdatum', 'beginn', 'ende', 'mietbeginn', 'liefertermin', 'eintrittsdatum'];

    for (const key of keys) {
      const sicher = anyDateLikeRow(
        key,
        '31.08.2026 Zwischentermine werden mit der Bauleitung abgestimmt.',
      );
      const unsicher = anyDateLikeRow(key, '31.08.2026 vorbehaltlich Freigabe durch den Auftraggeber');

      expect(sicher, `${key} sicher`).toEqual({ value: '31.08.2026', needsReview: false });
      expect(unsicher, `${key} unsicher`).toEqual({ value: '31.08.2026', needsReview: true });
    }
  });

  it('Unbekannter Resttext bleibt konservativ prüfbedürftig', () => {
    expect(isReviewRelevantDateRemainder('nach gesonderter Abstimmung')).toBe(true);
    expect(isReviewRelevantDateRemainder('')).toBe(false);
  });
});

/**
 * CONTRACT-REVIEW-UI-01C — nur der lokale Rest direkt am Datum zählt.
 *
 * Realfall: Der Seitentext zieht die Zeilen des PDF zusammen, sodass hinter dem
 * Datum ganze Folgeabschnitte stehen. Ein „oder" aus einem späteren § darf den
 * Review-Status des Datums nicht bestimmen.
 */
describe('CONTRACT-REVIEW-UI-01C – lokaler Datumsrest begrenzt die Review-Entscheidung', () => {
  const REAL_BEGINN =
    '31.08.2026 Geplantes Ausführungsende: 18.09.2026 Zwischentermine werden mit der Bauleitung ' +
    'abgestimmt. Änderungen des Bauablaufs sind frühzeitig mitzuteilen. § 7 Behinderungen und ' +
    'Unterbrechungen Behinderungen, fehlende Vorleistungen oder sonstige Umstände sind ' +
    'unverzüglich anzuzeigen.';

  const REAL_ENDE =
    '18.09.2026 Zwischentermine werden mit der Bauleitung abgestimmt. Änderungen des Bauablaufs ' +
    'sind frühzeitig mitzuteilen. § 7 Behinderungen und Unterbrechungen Behinderungen, fehlende ' +
    'Vorleistungen oder sonstige Umstände sind unverzüglich anzuzeigen.';

  it('echter NordWest-Beginn: Folgefeld beendet den lokalen Rest', () => {
    const proposal = buildProposal({ beginn: field(REAL_BEGINN) });
    const row = rowById(proposal, 'beginn');

    expect(row?.value).toBe('31.08.2026');
    expect(row?.needsReview).toBe(false);
  });

  it('echtes NordWest-Ende: Folgesatz und späterer § bleiben ohne Wirkung', () => {
    const proposal = buildProposal({ beginn: field('31.08.2026'), ende: field(REAL_ENDE) });
    const row = rowById(proposal, 'ende');

    expect(row?.value).toBe('18.09.2026');
    expect(row?.needsReview).toBe(false);
  });

  it('„oder" hinter einem neuen §-Abschnitt löst keinen Review aus', () => {
    expect(
      isReviewRelevantDateRemainder('§ 7 Behinderungen, fehlende Vorleistungen oder sonstige Umstände'),
    ).toBe(false);
  });

  it('„oder" unmittelbar am Datum bleibt review-relevant', () => {
    const proposal = buildProposal({ beginn: field('01.04.2026 oder nach Freigabe') });
    const row = rowById(proposal, 'beginn');

    expect(row?.value).toBe('01.04.2026');
    expect(row?.needsReview).toBe(true);
  });

  it('Realfall gilt für alle datumsartigen Felder', () => {
    const keys = ['vertragsdatum', 'beginn', 'ende', 'mietbeginn', 'liefertermin', 'eintrittsdatum'];

    for (const key of keys) {
      expect(anyDateLikeRow(key, REAL_BEGINN), `${key} realfall`).toEqual({
        value: '31.08.2026',
        needsReview: false,
      });
      expect(anyDateLikeRow(key, '31.08.2026 oder nach Freigabe'), `${key} bedingung`).toEqual({
        value: '31.08.2026',
        needsReview: true,
      });
    }
  });
});
