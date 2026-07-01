import { describe, expect, it } from 'vitest';
import {
  analyzeContract,
  analyzeContractFromInbox,
  SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT,
  SAMPLE_WERKVERTRAG_TEXT,
} from './contractAnalysisService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import type { InboxItem } from '../types/models';
const SAMPLE_INVOICE_TEXT = `
Rechnung Nr. RE-2026-8842
Rechnungsdatum: 15.03.2026
Rechnungsnummer: RE-2026-8842
Betrag: 1.247,80 €
Zahlungsziel: 14 Tage
`.trim();

const SAMPLE_BRIEF_TEXT = `
Sehr geehrte Damen und Herren,

hiermit laden wir Sie zur Mitgliederversammlung ein.

Mit freundlichen Grüßen
Handwerksinnung Berlin
`.trim();

describe('analyzeContract – Vertragserkennung', () => {
  it('erkennt Werkvertrag', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.isContract).toBe(true);
    expect(result.contractType).toBe('werkvertrag');
    expect(result.confidence).not.toBe('low');
  });

  it('erkennt Subunternehmervertrag', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT });

    expect(result.isContract).toBe(true);
    expect(result.contractType).toBe('subunternehmervertrag');
  });

  it('erkennt Auftrag per Upload-Hint', () => {
    const result = analyzeContract({
      recognizedText: 'Bestellung Sanierung',
      kindHint: 'auftrag',
    });

    expect(result.isContract).toBe(true);
    expect(result.contractType).toBe('auftrag');
    expect(result.confidence).toBe('high');
  });
});

describe('analyzeContract – Felderextraktion', () => {
  it('erkennt Bauvorhaben und Parteien', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.fields.bauvorhaben).toBe('Badezimmer-Sanierung Müller');
    expect(result.fields.auftraggeber).toBe('Müller Bau GmbH');
    expect(result.fields.subunternehmer).toBe('Mustermann Sanitär GmbH');
    expect(result.fields.baustellenadresse).toContain('Hauptstr. 12');
    expect(result.fields.auftragsnummer).toBe('AV-2026-0042');
    expect(result.fields.email).toContain('schmidt@');
  });
});

describe('analyzeContract – Positionen', () => {
  it('erkennt Leistungspositionen aus Tabelle', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.positions.length).toBe(3);
    expect(result.positions[0].description).toContain('Demontage');
    expect(result.positions[1].quantity).toBe(28);
    expect(result.positions[2].lineTotal).toBe(2800);
  });
});

describe('analyzeContract – Zahlungsbedingungen', () => {
  it('erkennt Netto, Skonto, Abschläge und Schlussrechnung', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    const labels = result.paymentTerms.map((t) => t.label);

    expect(labels).toContain('14 Tage netto');
    expect(labels.some((l) => l.includes('Skonto'))).toBe(true);
    expect(labels.some((l) => l.includes('Wöchentliche'))).toBe(true);
    expect(labels.some((l) => l.includes('Schlussrechnung'))).toBe(true);
  });

  it('erkennt 30 Tage netto im Subunternehmervertrag', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT });
    expect(result.paymentTerms.some((t) => t.label === '30 Tage netto')).toBe(true);
  });
});

describe('analyzeContract – Nachweispflichten', () => {
  it('erkennt Freistellung, BG BAU, SOKA, AOK, Haftpflicht', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    const types = result.requiredDocuments.map((d) => d.type);

    expect(types).toContain('freistellungsbescheinigung');
    expect(types).toContain('bg_bau');
    expect(types).toContain('soka_bau');
    expect(types).toContain('aok');
    expect(types).toContain('versicherung');
  });
});

describe('analyzeContract – Unterschriften', () => {
  it('erkennt Unterschriftsseiten und Hinweis', () => {
    const result = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });

    expect(result.signaturePages.length).toBeGreaterThanOrEqual(2);
    expect(result.signatureHint).toContain('unterschrieben');
  });
});

describe('analyzeContract – Fehlklassifizierung vermeiden', () => {
  it('klassifiziert Rechnung nicht als Vertrag', () => {
    const result = analyzeContract({
      recognizedText: SAMPLE_INVOICE_TEXT,
      kindHint: 'materialrechnung',
    });

    expect(result.isContract).toBe(false);
  });

  it('klassifiziert Brief nicht als Vertrag', () => {
    const result = analyzeContract({
      recognizedText: SAMPLE_BRIEF_TEXT,
      kindHint: 'brief',
    });

    expect(result.isContract).toBe(false);
  });
});

describe('Integration Upload → Analyse', () => {
  it('analysiert Auftrag-Upload mit Vertragstext', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'auftrag',
      recognizedText: SAMPLE_WERKVERTRAG_TEXT,
    });
    const analysis = analyzeContractFromInbox(item);

    expect(analysis.isContract).toBe(true);
    expect(analysis.fields.bauvorhaben).toBeTruthy();
    expect(analysis.positions.length).toBeGreaterThan(0);
    expect(analysis.suggestedActions.length).toBeGreaterThan(0);
  });

  it('analysiert Rechnungstext aus Inbox nicht als Vertrag', () => {
    const item: InboxItem = {
      id: 'inv-inbox',
      title: 'Rechnung Test',
      documentType: 'eingangsrechnung',
      classifiedKind: 'rechnung',
      sender: 'Lieferant',
      priority: 'mittel',
      deadline: null,
      recommendedAction: 'zuordnen',
      digitalFolder: { id: 'd', name: 'n', path: '/' },
      paperFiling: { folderId: 'folder-1', register: 'A', label: 'x' },
      status: 'neu',
      receivedAt: '2026-01-01',
      recognizedData: { _vertragstext: SAMPLE_INVOICE_TEXT },
      officePilotSuggestion: '',
      nextTaskLabel: '',
      securityHint: '',
    };

    expect(analyzeContractFromInbox(item).isContract).toBe(false);
  });
});
