/**
 * DOKUMENTVERSTAENDNIS-01C — die Abbildung von Bedeutung auf Sprache.
 *
 * Geprüft wird genau das, was in 01C neu entstanden ist: dass aus dem Kern aus
 * 01B verständliche Sätze werden, dass ein Einbehalt nicht wie eine Forderung
 * klingt, dass ein Gültigkeitsende nicht drängt und dass ein als „Sonstiges"
 * eingestuftes Schreiben einen brauchbaren nächsten Schritt bekommt.
 *
 * Der Kern selbst ist in 01B geprüft und wird hier nicht erneut getestet.
 *
 * Alle Texte sind frei erfunden.
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentMeaningViewFromCore } from './documentMeaningPresentationService';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../../types/documentSemanticCore';

function kern(teile: Partial<DocumentSemanticCore>): DocumentSemanticCore {
  return { ...emptyDocumentSemanticCore(), ...teile };
}

describe('01C — Fristen sprechen verständlich', () => {
  it('nennt bei jeder Frist, wofür sie gilt', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        deadlines: [
          { date: '2026-09-30', type: 'service_due', appliesTo: 'Leistung', actionRequired: true, certainty: 'detected' },
          { date: '2026-09-22', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' },
        ],
      }),
    );

    expect(view.deadlines.map((f) => f.text)).toEqual([
      'Antwort bis 22.09.2026',
      'Leistung erbringen bis 30.09.2026',
    ]);
    expect(view.deadlines.every((f) => f.isAction)).toBe(true);
  });

  it('macht aus einem Gültigkeitsende keine Aufforderung', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        deadlines: [
          { date: '2029-08-31', type: 'validity_period_end', appliesTo: 'Gültigkeit', actionRequired: false, certainty: 'detected' },
        ],
      }),
    );

    expect(view.deadlines[0].text).toBe('Gültig bis 31.08.2029');
    expect(view.deadlines[0].isAction).toBe(false);
    expect(view.actionNeed).toBe('no');
  });

  it('blendet das Briefdatum aus', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        deadlines: [
          { date: '2026-09-05', type: 'informational', appliesTo: 'Briefdatum', actionRequired: false, certainty: 'uncertain' },
        ],
      }),
    );
    expect(view.deadlines).toHaveLength(0);
  });
});

describe('01C — Beträge werden erklärt, nicht nur gezeigt', () => {
  it('erklärt einen Einbehalt ausdrücklich als keine Zahlung', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        amounts: [
          { value: 5000, currency: 'EUR', role: 'retention', isClaimAgainstUs: false, certainty: 'detected' },
        ],
      }),
    );

    expect(view.amounts[0].amount).toBe('5.000,00 €');
    expect(view.amounts[0].explanation).toContain('einbehalten');
    expect(view.amounts[0].explanation).toContain('keine Zahlung von Ihnen');
  });

  it('stellt die Gesamtforderung vor die Gebühr', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        amounts: [
          { value: 5, currency: 'EUR', role: 'fee', isClaimAgainstUs: true, certainty: 'detected' },
          { value: 4291.5, currency: 'EUR', role: 'total_claim', isClaimAgainstUs: true, certainty: 'detected' },
        ],
      }),
    );

    expect(view.amounts[0].amount).toBe('4.291,50 €');
    expect(view.amounts[0].explanation).toContain('Gesamtforderung');
    expect(view.amounts[1].explanation).toContain('Gebühr');
  });

  it('zeigt Netto und Steuer gar nicht erst', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        amounts: [
          { value: 3520, currency: 'EUR', role: 'net_amount', isClaimAgainstUs: false, certainty: 'detected' },
          { value: 668.8, currency: 'EUR', role: 'tax_amount', isClaimAgainstUs: false, certainty: 'detected' },
        ],
      }),
    );
    expect(view.amounts).toHaveLength(0);
  });
});

describe('01C — Buchführung in Klartext', () => {
  it('sagt bei einem Mängelschreiben, dass keine Ausgabe entsteht', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({ accounting: { relevance: 'none', reasons: [], certainty: 'detected' } }),
    );
    expect(view.accountingLabelKey).toBe('documentMeaning.accounting.none');
  });

  it('verweist bei einer Mahnung auf den vorhandenen Beleg', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({ accounting: { relevance: 'reference_only', reasons: [], certainty: 'detected' } }),
    );
    expect(view.accountingLabelKey).toBe('documentMeaning.accounting.reference');
    expect(view.nextStepKey).toBe('documentMeaning.next.checkExistingRecord');
  });

  it('bietet bei einer Rechnung die Übernahme an — als Prüfschritt', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({ accounting: { relevance: 'booking_candidate', reasons: [], certainty: 'detected' } }),
    );
    expect(view.accountingLabelKey).toBe('documentMeaning.accounting.candidate');
    expect(view.nextStepKey).toBe('documentMeaning.next.reviewAndBook');
  });
});

describe('01C — Handlungsbedarf aus der Bedeutung', () => {
  it('erkennt Handlungsbedarf aus einer befristeten eigenen Pflicht', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        obligations: [
          { who: 'own_company', what: 'Mängel beseitigen', byWhen: '2026-09-30', certainty: 'detected' },
        ],
      }),
    );
    expect(view.actionNeed).toBe('yes');
    expect(view.obligations).toHaveLength(1);
  });

  it('bleibt bei einer Pflicht ohne Frist ehrlich zurückhaltend', () => {
    /*
     * Ein Satz wie „Bitte legen Sie diese Bescheinigung Ihren Auftraggebern
     * vor" ist ein Hinweis zum Gebrauch, keine Aufforderung mit Termin. Ein
     * „Ja" daraus erzeugte bei einer Freistellungsbescheinigung eine Aufgabe
     * ohne Gegenstand; die Pflicht selbst bleibt trotzdem sichtbar.
     */
    const view = buildDocumentMeaningViewFromCore(
      kern({
        obligations: [{ who: 'own_company', what: 'Bescheinigung vorlegen', certainty: 'detected' }],
      }),
    );
    expect(view.actionNeed).toBe('unclear');
    expect(view.obligations).toHaveLength(1);
  });

  it('führt nur eigene Pflichten auf', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        obligations: [
          { who: 'own_company', what: 'Termin bestätigen', byWhen: '2026-09-22', certainty: 'detected' },
          { who: 'counterparty', what: 'Wir behalten 5.000 EUR ein', certainty: 'detected' },
        ],
      }),
    );
    expect(view.obligations).toHaveLength(1);
    expect(view.obligations[0].byWhen).toBe('22.09.2026');
  });

  it('bleibt bei fehlender Grundlage ehrlich unentschieden', () => {
    const view = buildDocumentMeaningViewFromCore(kern({}));
    expect(view.actionNeed).toBe('unclear');
    expect(view.nextStepKey).toBe('documentMeaning.next.reviewYourself');
  });
});

describe('01C — Kandidaten bleiben Vorschläge', () => {
  it('kennzeichnet einen knappen Treffer als zu prüfen', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        customerCandidates: [{ id: 'c1', name: 'Westfalen Projektbau GmbH', score: 0.6, reasons: ['Der Absender heisst so.'] }],
      }),
    );
    expect(view.customerCandidates[0].uncertain).toBe(true);
    expect(view.customerCandidates[0].reason).toBe('Der Absender heisst so.');
  });

  it('kennzeichnet bei mehreren Treffern alle als zu prüfen', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        vorgangCandidates: [
          { id: 'v1', name: 'Gewerbepark Senne', score: 1, reasons: ['Titel im Text.'] },
          { id: 'v2', name: 'Gewerbepark Nord', score: 0.95, reasons: ['Titel im Text.'] },
        ],
      }),
    );
    expect(view.vorgangCandidates.every((k) => k.uncertain)).toBe(true);
  });

  it('schlägt bei erkannten Kandidaten Bestätigen und Antworten vor', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({
        obligations: [
          { who: 'own_company', what: 'Mängel beseitigen', byWhen: '2026-09-30', certainty: 'detected' },
        ],
        customerCandidates: [{ id: 'c1', name: 'Westfalen Projektbau GmbH', score: 1, reasons: ['Absender.'] }],
      }),
    );
    expect(view.nextStepKey).toBe('documentMeaning.next.confirmAndAnswer');
  });
});

describe('01C — Ehrlichkeit', () => {
  it('benennt, was nicht sicher erkannt wurde', () => {
    const view = buildDocumentMeaningViewFromCore(kern({}));
    expect(view.uncertainties).toContain('documentMeaning.uncertain.noSubject');
    expect(view.uncertainties).toContain('documentMeaning.uncertain.recipient');
    expect(view.uncertainties).toContain('documentMeaning.uncertain.noAssignment');
  });

  it('zeigt sich gar nicht, wenn nichts belegbar ist', () => {
    expect(buildDocumentMeaningViewFromCore(kern({})).isEmpty).toBe(true);
  });

  it('gibt einen erkannten Betreff unverändert weiter', () => {
    const view = buildDocumentMeaningViewFromCore(
      kern({ subject: { value: 'Maengelanzeige - Gewerbepark Senne', certainty: 'detected' } }),
    );
    expect(view.subject).toBe('Maengelanzeige - Gewerbepark Senne');
    expect(view.uncertainties).not.toContain('documentMeaning.uncertain.noSubject');
  });
});
