/**
 * DOKUMENT-ASSISTENT-01E — der semantische Kern im Assistenten.
 *
 * Geprüft wird nur, was in 01E neu ist: dass der Kern in den Kontext gelangt,
 * dass er im Prompt so steht, dass eine Verwechslung ausgeschlossen ist, dass
 * die Nachweisprüfung ihn als Beleg anerkennt, und dass die alte Dokumentkarte
 * ihm nicht mehr widerspricht.
 *
 * Der Kern selbst ist in 01B geprüft, die Anzeige in 01C — beides nicht erneut.
 *
 * Alle Beispiele sind frei erfunden.
 */
import { describe, expect, it } from 'vitest';
import { buildSemanticPromptLines } from './documentAiSemanticPromptLines';
import { hasDemandEvidence, hasStructuredDeadlineEvidence } from './documentAiEvidence';
import { downgradeFamilyAgainstSemanticTruth } from '../documentSummary';
import type { DocumentAiContext } from '../../types/areaAi';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../../types/documentSemanticCore';

function kern(teile: Partial<DocumentSemanticCore>): DocumentSemanticCore {
  return { ...emptyDocumentSemanticCore(), ...teile };
}

function kontext(semantic?: DocumentSemanticCore): DocumentAiContext {
  return {
    sourceType: 'inbox',
    title: 'Testschreiben',
    issuerOrSender: 'Muster GmbH',
    category: 'sonstiges',
    recognizedDataLines: [],
    missingDocuments: [],
    tags: [],
    uncertainFieldNotes: [],
    missingFieldNotes: [],
    ...(semantic ? { semantic } : {}),
  };
}

const EINBEHALT = kern({
  amounts: [
    { value: 5000, currency: 'EUR', role: 'retention', isClaimAgainstUs: false, certainty: 'detected' },
  ],
  obligations: [
    { who: 'own_company', what: 'Mängel beseitigen', byWhen: '2026-09-30', certainty: 'detected' },
  ],
  deadlines: [
    { date: '2026-09-30', type: 'service_due', appliesTo: 'Leistung', actionRequired: true, certainty: 'detected' },
    { date: '2026-09-22', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' },
  ],
  accounting: { relevance: 'none', reasons: [], certainty: 'detected' },
});

describe('01E — der Kern erreicht den Prompt', () => {
  it('nennt bei jedem Betrag, ob er eine Forderung an uns ist', () => {
    const zeilen = buildSemanticPromptLines(EINBEHALT);
    const betrag = zeilen.find((z) => z.includes('5.000,00 EUR'));

    expect(betrag).toContain('Einbehalt der Gegenseite');
    expect(betrag).toContain('KEINE Forderung an uns');
    expect(zeilen.join('\n')).toContain('keine Zahlungspflicht');
  });

  it('warnt ausdrücklich, wenn kein Betrag eine Forderung ist', () => {
    expect(buildSemanticPromptLines(EINBEHALT).join('\n')).toContain(
      'Formuliere daraus keine Zahlungspflicht',
    );
  });

  it('kennzeichnet ein Gültigkeitsende als keine Handlungsfrist', () => {
    const zeilen = buildSemanticPromptLines(
      kern({
        deadlines: [
          { date: '2029-08-31', type: 'validity_period_end', appliesTo: 'Gültigkeit', actionRequired: false, certainty: 'detected' },
        ],
      }),
    );

    expect(zeilen.join('\n')).toContain('Ende der Gültigkeit (KEINE Handlungsfrist)');
    expect(zeilen.join('\n')).toContain('KEINE Handlung durch uns erforderlich');
    expect(zeilen.join('\n')).toContain(
      'Es gibt in diesem Schreiben KEINE Frist, bis zu der wir handeln müssen',
    );
  });

  it('hält beide Fristen mit ihrer eigenen Bedeutung auseinander', () => {
    const text = buildSemanticPromptLines(EINBEHALT).join('\n');
    expect(text).toContain('30.09.2026 — Frist zur Leistungserbringung');
    expect(text).toContain('22.09.2026 — Antwortfrist');
  });

  it('führt Kunden und Aufträge ausdrücklich als unbestätigte Vorschläge', () => {
    const text = buildSemanticPromptLines(
      kern({
        customerCandidates: [{ id: 'c1', name: 'Westfalen Projektbau GmbH', score: 1, reasons: ['Absender.'] }],
        vorgangCandidates: [{ id: 'v1', name: 'Gewerbepark Senne', score: 1, reasons: ['Im Text.'] }],
      }),
    ).join('\n');

    expect(text).toContain('Möglicher Kunde (NICHT bestätigt, nur Vorschlag): Westfalen Projektbau GmbH');
    expect(text).toContain('Möglicher Auftrag (NICHT bestätigt, nur Vorschlag): Gewerbepark Senne');
    expect(text).toContain('niemals als bestätigte Zuordnung');
  });

  it('nennt eine Gutschrift als Betrag zu unseren Gunsten', () => {
    const text = buildSemanticPromptLines(
      kern({
        amounts: [
          { value: 285.6, currency: 'EUR', role: 'credit_amount', isClaimAgainstUs: false, certainty: 'detected' },
        ],
      }),
    ).join('\n');

    expect(text).toContain('Gutschrift zu unseren Gunsten');
    expect(text).toContain('KEINE Forderung an uns');
  });

  it('bleibt bei fehlendem Kern vollständig stumm', () => {
    expect(buildSemanticPromptLines(undefined)).toEqual([]);
  });
});

describe('01E — der Kern zählt als Beleg', () => {
  it('erkennt eine gelesene eigene Pflicht als Aufforderung', () => {
    expect(hasDemandEvidence(kontext(EINBEHALT))).toBe(true);
  });

  it('erkennt eine gelesene Frist als Fristbeleg', () => {
    expect(hasStructuredDeadlineEvidence(kontext(EINBEHALT))).toBe(true);
  });

  it('macht aus einer Ankündigung der Gegenseite keine Aufforderung an uns', () => {
    const nurFremd = kern({
      obligations: [{ who: 'counterparty', what: 'Wir behalten 5.000 EUR ein', certainty: 'detected' }],
      deadlines: [
        { date: '2026-09-30', type: 'informational', appliesTo: 'Hinweis', actionRequired: false, certainty: 'uncertain' },
      ],
    });
    expect(hasDemandEvidence(kontext(nurFremd))).toBe(false);
  });

  it('verhält sich ohne Kern wie bisher', () => {
    expect(hasDemandEvidence(kontext())).toBe(false);
    expect(hasStructuredDeadlineEvidence(kontext())).toBe(false);
  });
});

describe('01E — die alte Karte widerspricht dem Kern nicht mehr', () => {
  it('stuft eine Gutschrift von der Eingangsrechnung herab', () => {
    const gutschrift = kern({
      amounts: [
        { value: 285.6, currency: 'EUR', role: 'credit_amount', isClaimAgainstUs: false, certainty: 'detected' },
      ],
      accounting: { relevance: 'reference_only', reasons: [], certainty: 'detected' },
    });
    expect(downgradeFamilyAgainstSemanticTruth('invoice_in', gutschrift)).toBe('generic');
  });

  it('lässt eine echte Eingangsrechnung unangetastet', () => {
    const rechnung = kern({
      amounts: [
        { value: 4188.8, currency: 'EUR', role: 'invoice_total', isClaimAgainstUs: true, certainty: 'detected' },
      ],
      accounting: { relevance: 'booking_candidate', reasons: [], certainty: 'detected' },
    });
    expect(downgradeFamilyAgainstSemanticTruth('invoice_in', rechnung)).toBe('invoice_in');
  });

  it('greift nur bei der Eingangsrechnung, nie bei anderen Familien', () => {
    const ohneForderung = kern({
      amounts: [
        { value: 100, currency: 'EUR', role: 'retention', isClaimAgainstUs: false, certainty: 'detected' },
      ],
    });
    expect(downgradeFamilyAgainstSemanticTruth('authority', ohneForderung)).toBe('authority');
    expect(downgradeFamilyAgainstSemanticTruth('letter', ohneForderung)).toBe('letter');
  });

  it('lässt Altdokumente ohne Kern unverändert', () => {
    expect(downgradeFamilyAgainstSemanticTruth('invoice_in', undefined)).toBe('invoice_in');
    expect(downgradeFamilyAgainstSemanticTruth('invoice_in', kern({}))).toBe('invoice_in');
  });
});
