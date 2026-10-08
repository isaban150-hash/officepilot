/**
 * P1MA WEISS — eine eindeutig zugeordnete Mitarbeiterquittung wird nicht wie
 * eingehende Post gedeutet: keine Kunden- oder Auftragsvorschläge, keine
 * erfundene Zuordnungsunsicherheit, keine aus dem Text gelesenen Beträge und
 * Termine (Betrag und Datum stehen fest in der Verknüpfung zur Zahlung).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDocumentMeaningView, buildEmployeePaymentMeaningView } from './documentMeaningPresentationService';
import { hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import type { Vorgang } from '../../types/models';

/** Der Quittungstext trägt zufällig den Titel eines offenen Auftrags. */
const QUITTUNG = [
  'Beispielbetrieb GmbH',
  'Auszahlungsquittung',
  'Quittung über eine Barauszahlung',
  'Referenz MZ-20261008-R8A1JP1G',
  'Auszahlungsdatum 08.10.2026',
  'Mitarbeiter/in Erika Beispiel',
  'Art der Zahlung Lohn/Gehalt',
  'Zahlungsweg Bar',
  'Ausgezahlter Betrag 350,00 €',
  'Verwendungszweck Lohn September Gewerbepark Senne',
  'Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.',
].join('\n');

/**
 * Erkannter Text der hochgeladenen, unterschriebenen Fassung — in der Struktur,
 * die der Upload ablegt: Vorspann der Eingangsanalyse, der Text der PDF zweimal
 * (als _extractedText und _vertragstext) und die Seitentexte als JSON in einer
 * Zeile. Dort stehen „Auslagenerstattung" und „12,50 €" im selben Satz.
 */
const UNTERSCHRIEBEN_PDF = [
  'Beispielbetrieb GmbH',
  'Beispielweg 1',
  '12345 Beispielstadt',
  'Auszahlungsquittung',
  'Quittung über eine Barauszahlung',
  'Referenz MZ-20261008-85TXHS2C',
  'Auszahlungsdatum 08.10.2026',
  'Mitarbeiter/in Max Probe',
  'Art der Zahlung Auslagenerstattung',
  'Zahlungsweg Bar',
  'Ausgezahlt durch',
  'Ausgezahlter Betrag',
  '12,50 €',
  'in Worten: zwölf Euro und fünfzig Cent',
  'Verwendungszweck',
  'Auslage Baumarkt',
  'Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.',
  'Beispielstadt, 08.10.2026',
  'Ort, Datum',
  'Unterschrift Auszahlende/r',
  'Unterschrift Empfänger/in',
  'Max Probe',
  'Auszahlungsquittung MZ-20261008-85TXHS2C Seite 1 von 1',
].join('\n');
const UNTERSCHRIEBEN = [
  'Dokumentart: quittung',
  'Betrag: 12,50 €',
  'Lieferant: Beispielbetrieb GmbH',
  `_extractedText: ${UNTERSCHRIEBEN_PDF}`,
  `_vertragstext: ${UNTERSCHRIEBEN_PDF}`,
  'Betreff: Unterschriebene Auszahlungsquittung MZ-20261008-85TXHS2C – Max Probe',
  `_pageTexts: ${JSON.stringify([{ pageNumber: 1, text: UNTERSCHRIEBEN_PDF }])}`,
].join('\n');

function auftrag(): Vorgang {
  return {
    id: 'vg-1',
    title: 'Gewerbepark Senne',
    customer: 'Westfalen Projektbau GmbH',
    baustelle: 'Senne',
    status: 'in_arbeit',
    materialSource: 'standard',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
  } as unknown as Vorgang;
}

beforeEach(() => {
  resetVorgaenge();
  hydrateVorgangStore([auftrag()]);
});

describe('Mitarbeiterquittung ohne Kunden- und Auftragsdeutung', () => {
  it('Gegenprobe: die allgemeine Deutung schlägt den Auftrag vor', () => {
    const allgemein = buildDocumentMeaningView({ text: QUITTUNG });
    expect(allgemein.vorgangCandidates.map((kandidat) => kandidat.name)).toContain('Gewerbepark Senne');
  });

  it('Gegenprobe: die allgemeine Deutung liest Betrag und Datum der Auszahlung als Betrag und Termin im Schreiben', () => {
    const allgemein = buildDocumentMeaningView({ text: UNTERSCHRIEBEN });
    expect(allgemein.amounts.map((betrag) => betrag.explanation)).toContain('Gutschrift zu Ihren Gunsten. Es ist keine Zahlung von Ihnen.');
    expect(allgemein.deadlines.map((frist) => frist.text).join(' ')).toContain('Zahlung');
  });

  it('die unterschriebene Fassung: keine gelesenen Beträge und Termine — sie stehen fest in der Verknüpfung', () => {
    const view = buildEmployeePaymentMeaningView({
      text: UNTERSCHRIEBEN,
      action: { need: 'no', text: 'Nein', nextStep: 'Keine Handlung nötig.' },
    });
    expect(view.amounts).toEqual([]);
    expect(view.deadlines).toEqual([]);
    expect(view.customerCandidates).toEqual([]);
    expect(view.vorgangCandidates).toEqual([]);
    expect(view.uncertainties).toEqual([]);
  });

  it('die Mitarbeiterquittung schlägt weder Kunden noch Aufträge vor und behauptet keine Unsicherheit', () => {
    const view = buildEmployeePaymentMeaningView({
      text: QUITTUNG,
      action: { need: 'no', text: 'Nein', nextStep: 'Keine Handlung nötig.' },
    });
    expect(view.customerCandidates).toEqual([]);
    expect(view.vorgangCandidates).toEqual([]);
    expect(view.uncertainties).toEqual([]);
    expect(view.obligations).toEqual([]);
    expect(view.deadlines).toEqual([]);
    expect(view.amounts).toEqual([]);
    expect(view.accountingLabelKey).toBe('documentMeaning.accounting.employeePayment');
    expect(view.accountingHintKey).toBe('documentMeaning.accounting.employeePaymentHint');
    expect(view.actionNeed).toBe('no');
    expect(view.nextStepText).toBe('Keine Handlung nötig.');
    expect(view.isEmpty).toBe(false);
  });

  it('die offene Quittung nennt den nächsten Schritt aus dem Zahlungsstand', () => {
    const view = buildEmployeePaymentMeaningView({
      text: QUITTUNG,
      action: { need: 'yes', text: 'Ja', nextStep: 'Quittung unterschreiben lassen und hochladen.' },
    });
    expect(view.actionNeed).toBe('yes');
    expect(view.actionNeedText).toBe('Ja');
    expect(view.nextStepText).toBe('Quittung unterschreiben lassen und hochladen.');
  });
});
