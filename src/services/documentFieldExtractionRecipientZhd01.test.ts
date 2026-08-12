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

/**
 * GOLD-PDF-PARTY-DIRECTION-02 — native PDF text keeps the line break, so "z. Hd."
 * can start its own line and the recipient sits on the line above. The lookback used
 * to be cut at the last line break, which left an empty segment.
 */
describe('documentFieldExtraction — recipient on the line before z. Hd.', () => {
  it('recognizes a recipient on the preceding line (LF)', () => {
    const text = [
      'Cirmak SHK GmbH',
      'Industriestraße 18 · 32105 Bad Salzuflen · info@cirmak.example',
      'Muster Bau GmbH',
      'z. Hd. Max Mustermann',
      'Hauptstraße 1',
      '10115 Berlin',
    ].join('\n');

    expect(recipientOf(text)).toBe('Muster Bau GmbH');
  });

  it('recognizes a recipient on the preceding line (CRLF)', () => {
    const text = [
      'Cirmak SHK GmbH',
      'Industriestraße 18 · 32105 Bad Salzuflen',
      'WEG Mehrfamilienhaus Nord',
      'z. Hd. Hausverwaltung Nord',
      '33602 Bielefeld',
    ].join('\r\n');

    expect(recipientOf(text)).toMatch(/^WEG Mehrfamilienhaus Nord$/i);
  });

  it('keeps recognizing a recipient on the same line as the marker', () => {
    const text = ['Cirmak SHK GmbH', 'Muster Bau GmbH z. Hd. Max Mustermann', 'Berlin'].join('\n');
    expect(recipientOf(text)).toBe('Muster Bau GmbH');
  });

  it('does not take the issuer as recipient', () => {
    const text = [
      'Cirmak Haustechnik GmbH',
      'Absender: Cirmak Haustechnik GmbH',
      'z. Hd. Buchhaltung',
      'Industriestraße 18',
    ].join('\n');

    expect(recipientOf(text)).toBeUndefined();
  });

  it('does not take an e-mail, address or heading line as recipient', () => {
    const text = [
      'Cirmak SHK GmbH',
      'Ausgangsrechnung',
      'info@cirmak-haustechnik.example',
      'z. Hd. Buchhaltung',
    ].join('\n');

    expect(recipientOf(text)).toBeUndefined();
  });

  it('does not reach back beyond the single preceding line', () => {
    const text = [
      'Muster Bau GmbH',
      'Rechnungsanschrift',
      'z. Hd. Max Mustermann',
    ].join('\n');

    // "Rechnungsanschrift" is the immediately preceding line and is no valid party,
    // so the older "Muster Bau GmbH" two lines up must not be pulled in.
    expect(recipientOf(text)).toBeUndefined();
  });

  /**
   * Guard for the segment-bounding ORDER: empties must be dropped only after the window
   * was bounded to two physical lines. A marker at the start of its own line leaves an
   * empty trailing segment; removing it first would pull one extra older line into range.
   * The issuer here differs from the foreign company, so the issuer exclusion cannot mask
   * the defect.
   */
  it('does not pull in a foreign company two lines before the marker', () => {
    const text = [
      'Cirmak Haustechnik GmbH',
      'Fremd Bau GmbH',
      'Rechnungsanschrift',
      'z. Hd. Max Mustermann',
      '33602 Bielefeld',
    ].join('\n');

    expect(recipientOf(text)).toBeUndefined();
  });

  it('does not skip a blank line between candidate and marker', () => {
    const text = [
      'Cirmak Haustechnik GmbH',
      'Fremd Bau GmbH',
      '',
      'z. Hd. Max Mustermann',
      '33602 Bielefeld',
    ].join('\n');

    // The blank line is the one allowed preceding physical line — it must be consumed,
    // not skipped over to reach the candidate above it.
    expect(recipientOf(text)).toBeUndefined();
  });

  it('returns undefined when no safe candidate exists', () => {
    const text = ['Cirmak SHK GmbH', 'z. Hd. Frau Weber', 'Berlin'].join('\n');
    expect(recipientOf(text)).toBeUndefined();
  });
});
