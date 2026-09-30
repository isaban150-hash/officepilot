/**
 * Wartungsfix nach 01C-1 — Legacy-Freistellungsbescheinigung / Gültigkeit.
 *
 * Seit EINGANG-01A ist `deadline` eine Handlungsfrist und nie pauschal ein
 * Gültigkeitsende. Historische Freistellungen (vor 01A) tragen ihr
 * Gültigkeitsende aber nur als rohe `deadline` im Format TT.MM.JJJJ — ohne
 * `Gültig_bis`, ohne Text. Nur für genau diesen Fall liest der Archiv-Import
 * die alte `deadline` als Legacy-Gültigkeit. Eine ISO-`deadline` ohne Text
 * (moderne Freistellung auf einem Zweitgerät: `_extractedText` wird nicht
 * synchronisiert) bleibt eine Handlungsfrist. Echte Kette:
 * `mapInboxItemToDocumentInput` bzw. der Archiv-Import und die ProofMemory.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { importInboxDocumentForTests } from '../test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from '../test/fixtures';
import { classifyDocument } from './documentClassificationService';
import { hydrateDocumentStore, mapInboxItemToDocumentInput } from './documentService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { getProofMemories, resetMemory } from './officePilotMemoryService';
import type { InboxItem } from '../types/models';

const COMPANY = 'Test GmbH';

function legacyExemption(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-legacy-freistellung',
    title: 'Freistellungsbescheinigung §48b',
    documentType: 'behoerde',
    classifiedKind: 'freistellungsbescheinigung',
    sender: 'Finanzamt München',
    deadline: '31.12.2026',
    recognizedData: { Dokument: 'Freistellungsbescheinigung nach §48b EStG' },
    ...overrides,
  });
}

function freistellungProof() {
  return getProofMemories().find((entry) => entry.proofType === 'freistellungsbescheinigung');
}

beforeEach(() => {
  localStorage.clear();
  resetMemory();
  hydrateDocumentStore([]);
});

describe('Legacy-Freistellung — Gültigkeit aus der alten deadline', () => {
  it('T1: Altbestand (deadline 31.12.2026 roh, kein Gültig_bis, kein Text) → Gültigkeit und ProofMemory „valid"', () => {
    const item = legacyExemption();
    expect(mapInboxItemToDocumentInput(item, COMPANY).validUntil).toBe('2026-12-31');

    const result = importInboxDocumentForTests(item, COMPANY);
    expect(result.success).toBe(true);
    expect(freistellungProof()?.validUntil).toBe('2026-12-31');
    expect(freistellungProof()?.status).toBe('valid');
  });

  it('T1b: historisches Rohformat mit einstelligem Tag/Monat (1.3.2027) wird als Tag gelesen', () => {
    expect(mapInboxItemToDocumentInput(legacyExemption({ deadline: '1.3.2027' }), COMPANY).validUntil).toBe('2027-03-01');
  });

  it('T3: Zweitgerät — moderne synchronisierte Freistellung (ISO-deadline, kein Text, kein Gültig_bis) → kein validUntil', () => {
    const item = legacyExemption({ id: 'inbox-sync-freistellung', deadline: '2026-10-15' });
    expect(mapInboxItemToDocumentInput(item, COMPANY).validUntil).toBeNull();

    const result = importInboxDocumentForTests(item, COMPANY);
    expect(result.success).toBe(true);
    expect(freistellungProof()?.validUntil ?? null).toBeNull();
    expect(freistellungProof()?.status).toBe('unknown');
  });

  it('T4: Nicht-Freistellung mit roher TT.MM.JJJJ-deadline → deadline ist NICHT validUntil', () => {
    for (const classifiedKind of ['eingangsrechnung', 'finanzamt', 'unbedenklichkeitsbescheinigung', 'mahnung'] as const) {
      const input = mapInboxItemToDocumentInput(legacyExemption({ id: `x-${classifiedKind}`, classifiedKind }), COMPANY);
      expect(input.validUntil, classifiedKind).toBeNull();
    }
    expect(mapInboxItemToDocumentInput(legacyExemption({ classifiedKind: undefined }), COMPANY).validUntil).toBeNull();
  });

  it('T5: explizites Gültig_bis gewinnt vor der Legacy-deadline', () => {
    const item = legacyExemption({ recognizedData: { Dokument: 'Freistellung', Gültig_bis: '30.06.2027' } });
    expect(mapInboxItemToDocumentInput(item, COMPANY).validUntil).toBe('2027-06-30');
  });

  it('T6: moderne Freistellung mit Text — Handlungsfrist und Gültigkeit bleiben getrennt', () => {
    const text = 'Freistellungsbescheinigung nach § 48b EStG\nGültig bis 31.08.2029\nBitte reichen Sie die Unterlagen bis zum 15.10.2026 ein.';
    const item = legacyExemption({
      deadline: '2026-10-15',
      recognizedData: withInboxExtractedDocumentText({ Dokument: 'Freistellung' }, text),
    });
    // Gültigkeit aus dem Text, nicht aus der Handlungsfrist.
    expect(mapInboxItemToDocumentInput(item, COMPANY).validUntil).toBe('2029-08-31');
  });

  it('T7: moderne Freistellung mit Text, aber ohne erkennbares Gültigkeitsende → kein Rückfall auf deadline', () => {
    for (const deadline of ['2026-10-15', '15.10.2026']) {
      const item = legacyExemption({
        deadline,
        recognizedData: withInboxExtractedDocumentText({ Dokument: 'Freistellung' }, 'Freistellungsbescheinigung\nBitte bis zum 15.10.2026 antworten.'),
      });
      expect(mapInboxItemToDocumentInput(item, COMPANY).validUntil, deadline).toBeNull();
    }
  });

  it('T8: ungültige alte Daten → fail-closed, kein erfundener Status', () => {
    for (const deadline of ['31.02.2026', 'demnächst', '12/2026', '31/12/2026', '31.12.26', ' ', '', null]) {
      expect(mapInboxItemToDocumentInput(legacyExemption({ deadline }), COMPANY).validUntil, String(deadline)).toBeNull();
    }
    const result = importInboxDocumentForTests(legacyExemption({ id: 'inbox-legacy-unklar', deadline: '31.02.2026' }), COMPANY);
    expect(result.success).toBe(true);
    expect(freistellungProof()?.validUntil ?? null).toBeNull();
    expect(freistellungProof()?.status).toBe('unknown');
  });

  it('T9: 01A-Kernregel — der allgemeine Intake leitet validUntil nicht aus der Handlungsfrist ab', () => {
    const invoice = classifyDocument({
      kindHint: 'eingangsrechnung',
      recognizedText: 'Rechnung\nAn: Test GmbH\nRechnungsnummer: R-1\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026',
    });
    expect(invoice.deadline).toBe('2026-10-15');
    const item = createAuftragInboxItem({
      id: 'inbox-rechnung-frist',
      documentType: 'eingangsrechnung',
      classifiedKind: 'eingangsrechnung',
      deadline: invoice.deadline,
      recognizedData: { Rechnungsnummer: 'R-1' },
    });
    expect(mapInboxItemToDocumentInput(item, COMPANY).validUntil).toBeNull();
  });
});
