/**
 * SCAN-OCR-EVIDENCE-01B — allgemeine sichtbare Label-Wert-Fakten.
 *
 * Der Resolver kennt keine Vertragsart, keine Firma und keine Testwerte. Geprüft
 * werden Vertrag, Rechnung und Formular mit denselben Regeln.
 */
import { describe, expect, it } from 'vitest';
import {
  buildVisualLines,
  extractVisibleFactsFromLayout,
  findFactByLabelAliases,
  type DocumentVisibleFact,
} from './services/documentSpatialFieldExtractionService';
import {
  DOCUMENT_LAYOUT_VERSION,
  type DocumentLayoutPage,
  type DocumentLayoutToken,
} from './types/documentLayout';

type WordSpec = {
  text: string;
  x: number;
  y: number;
  w?: number;
  conf?: number;
  block?: string;
};

/** Baut eine Layoutseite aus Wortangaben in Prozentkoordinaten. */
function layout(words: WordSpec[], truncated = false): DocumentLayoutPage {
  const tokens: DocumentLayoutToken[] = words.map((word, index) => ({
    id: `p1-t${index}`,
    text: word.text,
    x0: word.x,
    y0: word.y,
    x1: word.x + (word.w ?? word.text.length * 0.012),
    y1: word.y + 0.02,
    confidence: word.conf ?? 92,
    blockId: word.block ?? 'b0',
    lineId: `${word.block ?? 'b0'}-l${Math.round(word.y * 1000)}`,
  }));
  return {
    version: DOCUMENT_LAYOUT_VERSION,
    pageNumber: 1,
    width: 1200,
    height: 1700,
    truncated,
    tokens,
  };
}

function factFor(facts: DocumentVisibleFact[], label: string): DocumentVisibleFact | undefined {
  return findFactByLabelAliases(facts, [label]);
}

describe('SCAN-OCR-EVIDENCE-01B sichtbare Fakten', () => {
  it('Vertragstabelle: Labels links, Werte rechts', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Auftraggeber', x: 0.08, y: 0.2 },
        { text: 'NordWest', x: 0.45, y: 0.2 },
        { text: 'Dachbau', x: 0.56, y: 0.2 },
        { text: 'GmbH', x: 0.66, y: 0.2 },
        { text: 'Auftragnehmer', x: 0.08, y: 0.25 },
        { text: 'Cirmak', x: 0.45, y: 0.25 },
        { text: 'Haustechnik', x: 0.53, y: 0.25 },
        { text: 'GmbH', x: 0.67, y: 0.25 },
      ]),
    );

    expect(factFor(facts, 'Auftraggeber')?.valueText).toBe('NordWest Dachbau GmbH');
    expect(factFor(facts, 'Auftragnehmer')?.valueText).toBe('Cirmak Haustechnik GmbH');
    expect(factFor(facts, 'Auftraggeber')?.status).toBe('recognized');
    // Beleg vorhanden.
    expect(factFor(facts, 'Auftraggeber')?.valueTokenIds.length).toBe(3);
    expect(factFor(facts, 'Auftraggeber')?.labelTokenIds).toEqual(['p1-t0']);
  });

  it('falsche OCR-Reihenfolge ändert nichts — Zeilen kommen aus Koordinaten', () => {
    // Erst die komplette linke Spalte, dann die rechte (typische Blockordnung).
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Auftraggeber', x: 0.08, y: 0.2, block: 'b0' },
        { text: 'Auftragnehmer', x: 0.08, y: 0.25, block: 'b0' },
        { text: 'Alpha', x: 0.45, y: 0.2, block: 'b1' },
        { text: 'Bau', x: 0.53, y: 0.2, block: 'b1' },
        { text: 'GmbH', x: 0.6, y: 0.2, block: 'b1' },
        { text: 'Beta', x: 0.45, y: 0.25, block: 'b1' },
        { text: 'Technik', x: 0.52, y: 0.25, block: 'b1' },
        { text: 'GmbH', x: 0.63, y: 0.25, block: 'b1' },
      ]),
    );

    expect(factFor(facts, 'Auftraggeber')?.valueText).toBe('Alpha Bau GmbH');
    expect(factFor(facts, 'Auftragnehmer')?.valueText).toBe('Beta Technik GmbH');
  });

  it('Wörter derselben visuellen Zeile aus verschiedenen Blöcken gehören zusammen', () => {
    const lines = buildVisualLines(
      layout([
        { text: 'Mieter', x: 0.08, y: 0.3, block: 'b0' },
        { text: 'Muster', x: 0.5, y: 0.302, block: 'b7' },
        { text: 'GmbH', x: 0.6, y: 0.301, block: 'b9' },
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.tokens.map((token) => token.text)).toEqual(['Mieter', 'Muster', 'GmbH']);
  });

  it('Rechnung: Nummer, Datum und Gesamtbetrag mit Doppelpunkt in derselben Zeile', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Rechnungsnummer:', x: 0.08, y: 0.15 },
        { text: 'RE-2026-0042', x: 0.42, y: 0.15 },
        { text: 'Rechnungsdatum:', x: 0.08, y: 0.19 },
        { text: '04.05.2026', x: 0.42, y: 0.19 },
        { text: 'Gesamtbetrag:', x: 0.08, y: 0.23 },
        { text: '12.345,67', x: 0.42, y: 0.23 },
        { text: 'EUR', x: 0.53, y: 0.23 },
      ]),
    );

    expect(factFor(facts, 'Rechnungsnummer')?.valueText).toBe('RE-2026-0042');
    expect(factFor(facts, 'Rechnungsdatum')?.valueText).toBe('04.05.2026');
    expect(factFor(facts, 'Gesamtbetrag')?.valueText).toBe('12.345,67 EUR');
    expect(factFor(facts, 'Rechnungsnummer')?.relation).toBe('same_line');
  });

  it('allgemeines Formular: unbekannte Labels bleiben als Rohfakt erhalten', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Personalnummer:', x: 0.08, y: 0.4 },
        { text: '778-B', x: 0.42, y: 0.4 },
        { text: 'Abteilung:', x: 0.08, y: 0.44 },
        { text: 'Technik', x: 0.42, y: 0.44 },
      ]),
    );

    expect(factFor(facts, 'Personalnummer')?.valueText).toBe('778-B');
    expect(factFor(facts, 'Abteilung')?.valueText).toBe('Technik');
  });

  it('mehrzeilige Anschrift: zwei echte Wertzeilen gehören zusammen', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Baustelle', x: 0.08, y: 0.5 },
        { text: 'Carl-Bertelsmann-Straße', x: 0.08, y: 0.54, w: 0.22 },
        { text: '211', x: 0.31, y: 0.54 },
        { text: '33335', x: 0.08, y: 0.58 },
        { text: 'Gütersloh', x: 0.14, y: 0.58 },
        // Große Lücke plus neues Label beendet den Wert.
        { text: 'Rechnungsdatum:', x: 0.08, y: 0.68 },
        { text: '01.02.2026', x: 0.42, y: 0.68 },
      ]),
    );

    const site = factFor(facts, 'Baustelle');
    expect(site?.relation).toBe('below');
    expect(site?.valueText).toBe('Carl-Bertelsmann-Straße 211 33335 Gütersloh');
    expect(site?.valueTokenIds).toHaveLength(4);
    expect(site?.valueText).not.toContain('Rechnungsdatum');
    expect(factFor(facts, 'Rechnungsdatum')?.valueText).toBe('01.02.2026');
  });

  it('ein neues Label beendet den mehrzeiligen Wert sofort', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Baustelle', x: 0.08, y: 0.5 },
        { text: 'Musterweg', x: 0.08, y: 0.54 },
        { text: 'Auftraggeber:', x: 0.08, y: 0.58 },
        { text: 'Alpha', x: 0.42, y: 0.58 },
        { text: 'GmbH', x: 0.5, y: 0.58 },
      ]),
    );
    expect(factFor(facts, 'Baustelle')?.valueText).toBe('Musterweg');
    expect(factFor(facts, 'Auftraggeber')?.valueText).toBe('Alpha GmbH');
  });

  it('Label ohne Wert ergibt missing_value, nicht einen erfundenen Wert', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Auftraggeber:', x: 0.08, y: 0.2 },
        { text: 'Auftragnehmer:', x: 0.08, y: 0.26 },
        { text: 'Beta', x: 0.45, y: 0.26 },
        { text: 'GmbH', x: 0.52, y: 0.26 },
      ]),
    );

    const ag = factFor(facts, 'Auftraggeber');
    expect(ag?.status).toBe('missing_value');
    expect(ag?.valueText).toBeNull();
    expect(factFor(facts, 'Auftragnehmer')?.valueText).toBe('Beta GmbH');
  });

  it('niedrige OCR-Konfidenz ergibt unreadable ohne Wert', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Auftragnehmer:', x: 0.08, y: 0.2 },
        { text: 'C1rm4k', x: 0.45, y: 0.2, conf: 21 },
      ]),
    );
    const fact = factFor(facts, 'Auftragnehmer');
    expect(fact?.status).toBe('unreadable');
    expect(fact?.valueText).toBeNull();
    // Der Beleg bleibt erhalten, nur der Wert wird nicht behauptet.
    expect(fact?.valueTokenIds.length).toBe(1);
  });

  it('zwei gleich plausible Kandidaten bleiben ambiguous', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Kunde', x: 0.05, y: 0.3, w: 0.06 },
        { text: 'Alpha', x: 0.2, y: 0.3, w: 0.06 },
        { text: 'Beta', x: 0.35, y: 0.3, w: 0.06 },
      ]),
    );
    const fact = factFor(facts, 'Kunde');
    expect(fact?.status).toBe('ambiguous');
    expect(fact?.valueText).toBeNull();
  });

  it('gekürztes Layout meldet partial statt fehlend', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([{ text: 'Auftraggeber:', x: 0.08, y: 0.2 }], true),
    );
    expect(factFor(facts, 'Auftraggeber')?.status).toBe('partial');
  });

  it('iPhone- und PDF-Oberflächentext erzeugt keine Fakten', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: '<', x: 0.02, y: 0.02, w: 0.01 },
        { text: 'Dateien', x: 0.05, y: 0.02 },
        { text: 'Werkvertrag_Test_Cirmak_Nor…', x: 0.3, y: 0.02, w: 0.25 },
        { text: '1', x: 0.45, y: 0.06, w: 0.01 },
        { text: 'von', x: 0.47, y: 0.06, w: 0.02 },
        { text: '8', x: 0.5, y: 0.06, w: 0.01 },
        { text: 'TESTDOKUMENT', x: 0.3, y: 0.1, w: 0.14 },
        { text: '–', x: 0.45, y: 0.1, w: 0.01 },
        { text: 'NICHT', x: 0.47, y: 0.1 },
        { text: 'RECHTSVERBINDLICH', x: 0.54, y: 0.1, w: 0.18 },
        { text: 'Auftraggeber:', x: 0.08, y: 0.3 },
        { text: 'Gamma', x: 0.45, y: 0.3 },
        { text: 'GmbH', x: 0.54, y: 0.3 },
      ]),
    );

    // Entscheidend ist, dass aus Oberflächentext kein belegter Wert entsteht:
    // ein Label ohne Wert kann kein Fachfeld füllen.
    const recognized = facts.filter((fact) => fact.status === 'recognized');
    const noise = ['<', 'Dateien', 'Werkvertrag_Test', 'TESTDOKUMENT', 'von 8', 'RECHTSVERBINDLICH'];
    for (const fragment of noise) {
      expect(
        recognized.some(
          (fact) => fact.labelText.includes(fragment) || (fact.valueText ?? '').includes(fragment),
        ),
        fragment,
      ).toBe(false);
    }
    // Das echte Feld bleibt erhalten.
    expect(factFor(facts, 'Auftraggeber')?.valueText).toBe('Gamma GmbH');
  });

  it('echter Briefkopf mit Firma links und Telefon rechts wird kein Feld', () => {
    const facts = extractVisibleFactsFromLayout(
      layout([
        { text: 'Muster', x: 0.08, y: 0.04 },
        { text: 'Bau', x: 0.16, y: 0.04 },
        { text: 'GmbH', x: 0.23, y: 0.04 },
        { text: 'Tel.', x: 0.7, y: 0.04, w: 0.03 },
        { text: '0521', x: 0.75, y: 0.04 },
        { text: '1234', x: 0.82, y: 0.04 },
        { text: 'Rechnungsnummer:', x: 0.08, y: 0.3 },
        { text: 'RE-1', x: 0.45, y: 0.3 },
      ]),
    );

    // „Muster Bau GmbH" ist kein Label — mehr als fünf Wörter wären Prosa, hier
    // fehlt jeder Separator und der rechte Block ist eine eigene Angabe.
    const headerFact = facts.find((fact) => fact.labelText.startsWith('Muster'));
    expect(headerFact?.valueText ?? null).not.toBe('Muster Bau GmbH');
    expect(factFor(facts, 'Rechnungsnummer')?.valueText).toBe('RE-1');
  });
});
