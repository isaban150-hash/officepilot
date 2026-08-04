import { describe, expect, it } from 'vitest';
import { extractFieldsWithConfidence } from './documentFieldExtractionService';

function recipientOf(text: string): string | undefined {
  return extractFieldsWithConfidence(text).Empfänger?.value;
}

describe('documentFieldExtraction — RECIPIENT_ZHD freeze guard', () => {
  it('recognizes a short valid z. Hd. recipient block', () => {
    const text = [
      'Cirmak SHK GmbH',
      'Muster Bau GmbH z. Hd. Max Mustermann',
      'Hauptstraße 1',
      '10115 Berlin',
    ].join('\n');

    expect(recipientOf(text)).toBe('Muster Bau GmbH');
  });

  it('recognizes z.Hd. without space after the period', () => {
    const text = [
      'Cirmak SHK GmbH',
      'Nordwest Sanitär AG z.Hd. Frau Schmidt',
      'Berlin',
    ].join('\n');
    expect(recipientOf(text)).toBe('Nordwest Sanitär AG');
  });

  it('recognizes WEG recipients before z. Hd.', () => {
    const text = [
      'Cirmak SHK GmbH',
      'WEG Am Parkhaus z. Hd. Hausverwaltung Meyer',
      'Ort',
    ].join('\n');
    expect(recipientOf(text)).toMatch(/^WEG Am Parkhaus$/i);
  });

  it('returns no zHd recipient for long flat text without attention markers, and finishes quickly', () => {
    const chunk =
      'Werkvertrag Subunternehmer Leistungsverzeichnis Positionen Netto Brutto Auftraggeber Auftragnehmer ';
    const flat = chunk.repeat(320); // ~28k chars, almost no newlines
    expect(flat.length).toBeGreaterThan(27_000);
    expect(flat.split(/\r?\n/).length).toBeLessThan(5);

    const started = performance.now();
    const recipient = recipientOf(flat);
    const elapsedMs = performance.now() - started;

    expect(recipient).toBeUndefined();
    // Generous ceiling: catastrophic backtracking hangs for seconds/minutes.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('returns no zHd recipient for ~28k flat text without hanging (regression for Werkvertrag shape)', () => {
    const line =
      'Subunternehmervertrag zwischen den Parteien mit umfangreichen Leistungsbeschreibungen und Preisen ' +
      'für Positionen ohne zHd Markierung aber mit vielen GmbH AG KG OHG GbR UG Token ';
    // Few very long lines — same structural shape as the freezing PDF extract.
    const text = [line.repeat(40), line.repeat(40), line.repeat(40)].join('\n');
    expect(text.length).toBeGreaterThan(20_000);
    expect(text.split(/\r?\n/).length).toBe(3);

    const started = performance.now();
    const fields = extractFieldsWithConfidence(text);
    const elapsedMs = performance.now() - started;

    expect(fields.Empfänger?.value).toBeUndefined();
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('still extracts Empfänger when a z. Hd. block appears inside a longer document', () => {
    const prefix = 'Cirmak SHK GmbH\nVertragsbedingungen '.repeat(50);
    const text = `${prefix}\nAlpha Beta Gamma GmbH z. Hd. Frau Weber\nSchlussklausel`;
    expect(recipientOf(text)).toBe('Alpha Beta Gamma GmbH');
  });
});
