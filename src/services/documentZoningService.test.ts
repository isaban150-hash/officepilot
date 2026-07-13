import { describe, expect, it } from 'vitest';
import { classifyDocument } from './documentClassificationService';
import {
  buildCanonicalDocumentText,
  buildEvidenceIndex,
  findZonedLineAtOffset,
  validateZoneEvidenceIndex,
  zoneDocumentText,
  zoneText,
} from './documentZoningService';
import { buildPageMarker } from './documentSegmentationService';
import { resetLegacyAnalysisShadowInvocationCountForTests } from './documentAnalysisShadowService';
import { isValidEvidenceRef } from '../types/documentAnalysis';

const AUTHORITY_LETTER = [
  'Finanzamt Musterstadt',
  'Betreff: Umsatzsteuervoranmeldung',
  'Sehr geehrte Damen und Herren,',
  'bitte reichen Sie die Unterlagen bis 30.06.2026 ein.',
  'Mit freundlichen Grüßen',
  'Finanzamt Musterstadt',
  'HRB 12345 Amtsgericht Musterstadt',
  'Geschäftsführer: Max Mustermann',
].join('\n');

describe('documentZoningService', () => {
  it('separates header, body and footer on a standard letter', () => {
    const zoned = zoneText(AUTHORITY_LETTER);

    expect(zoned.headerLines.length).toBeGreaterThan(0);
    expect(zoned.bodyLines.length).toBeGreaterThan(0);
    expect(zoned.footerLines.length).toBeGreaterThan(0);
    expect(zoned.tableLines).toEqual([]);
    expect(zoned.headerLines[0]?.text).toContain('Finanzamt');
    expect(zoned.footerLines.some((line) => /HRB|Amtsgericht/i.test(line.text))).toBe(true);
  });

  it('keeps HRB and register court lines in the footer zone', () => {
    const zoned = zoneText(AUTHORITY_LETTER);
    const footerText = zoned.footerLines.map((line) => line.text).join('\n');

    expect(footerText).toMatch(/HRB 12345/);
    expect(footerText).toMatch(/Amtsgericht Musterstadt/);
    expect(zoned.bodyLines.some((line) => /HRB|Amtsgericht/i.test(line.text))).toBe(false);
  });

  it('keeps short receipts mostly in the body without footer dominance', () => {
    const receipt = ['ARAL Tankstelle', 'Diesel 52,18 EUR', 'Danke'].join('\n');
    const zoned = zoneText(receipt);

    expect(zoned.bodyLines.length).toBeGreaterThanOrEqual(1);
    expect(zoned.footerLines.length).toBeLessThanOrEqual(1);
    expect(zoned.bodyLines.some((line) => /Diesel/i.test(line.text))).toBe(true);
    expect(zoned.footerLines.every((line) => !/Diesel/i.test(line.text))).toBe(true);
  });

  it('assigns page numbers for multi-page OCR text', () => {
    const pageTexts = [
      { pageNumber: 1, text: 'Seite eins Betreff Vertrag' },
      { pageNumber: 2, text: 'Seite zwei Leistungsbeschreibung' },
    ];
    const canonical = buildCanonicalDocumentText(undefined, pageTexts);
    const zoned = zoneDocumentText(canonical, pageTexts);

    expect(canonical).toContain(buildPageMarker(2).trim());
    expect(zoned.lines.some((line) => line.pageNumber === 1)).toBe(true);
    expect(zoned.lines.some((line) => line.pageNumber === 2)).toBe(true);
  });

  it('builds a valid evidence index with offsets and line references', () => {
    const zoned = zoneText(AUTHORITY_LETTER);
    const evidenceIndex = buildEvidenceIndex(zoned);

    expect(validateZoneEvidenceIndex(evidenceIndex)).toBe(true);
    expect(Object.keys(evidenceIndex).some((key) => key.startsWith('zone:footer:'))).toBe(true);

    const footerEvidence = Object.values(evidenceIndex).find((entry) => /HRB/.test(entry.snippet));
    expect(footerEvidence?.zone).toBe('footer');
    expect(footerEvidence?.startOffset).toBeGreaterThanOrEqual(0);
    expect(footerEvidence?.startLine).toBeGreaterThan(0);
    expect(isValidEvidenceRef(footerEvidence)).toBe(true);
  });

  it('resolves zoned lines by offset for later evidence mapping', () => {
    const zoned = zoneText(AUTHORITY_LETTER);
    const target = zoned.lines.find((line) => /HRB/.test(line.text));

    expect(target).toBeDefined();
    expect(findZonedLineAtOffset(zoned, target!.startOffset)?.zone).toBe('footer');
  });

  it('does not change productive classification output when shadow zoning runs', () => {
    resetLegacyAnalysisShadowInvocationCountForTests();
    const input = {
      recognizedText: AUTHORITY_LETTER,
      senderHint: 'Finanzamt Musterstadt',
    };

    const result = classifyDocument(input);

    expect(result.classifiedKind).toBe('finanzamt');
    expect(result.sender).toBe('Finanzamt Musterstadt');
  });
});
