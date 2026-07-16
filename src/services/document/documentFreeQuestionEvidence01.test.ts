import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { t } from '../../i18n';
import { setAiGenerateTextForTests } from '../ai/aiRequestRunner';
import { askDocumentAi } from './documentAiService';
import { buildDocumentAiContextFromDocument } from './documentAiContextService';
import { detectDocumentNature } from './documentAiDocumentNature';
import { applyDocumentAiAnswerPostCheck } from './documentAiAnswerPostCheck';
import { parseDocumentAiAnswer } from './documentAiAnswerParser';
import {
  canClaimDocumentDemandWithDate,
  hasStructuredDeadlineEvidence,
} from './documentAiEvidence';
import type { CompanyDocument } from '../../types/models';
import type { DocumentAiContext } from '../../types/areaAi';

const testInvoice: CompanyDocument = {
  id: 'doc-evidence-test',
  title: 'Testrechnung',
  category: 'rechnung',
  issuer: 'Demo',
  recognizedText:
    'Dies ist eine Testrechnung. Es besteht keine echte Forderung. Bitte nicht bezahlen. Datum 29.07.2026.',
  issueDate: '2026-07-01',
  validUntil: null,
  digitalFolder: { id: 'd', name: 'Rechnungen', path: '/Rechnungen/' },
  paperFolder: { folderId: 'f', register: 'A', label: 'Rechnungen' },
  tags: [],
  linkedCompany: 'Test GmbH',
  linkedVorgang: null,
  archived: true,
  classifiedKind: 'sonstiges',
  createdAt: '2026-01-01T12:00:00.000Z',
};

const mahnung: CompanyDocument = {
  id: 'doc-evidence-mahnung',
  title: 'Mahnung',
  category: 'rechnung',
  issuer: 'Lieferant GmbH',
  recognizedText:
    'Mahnung. Zahlungsaufforderung: Bitte überweisen Sie den offenen Betrag bis 29.07.2026.',
  issueDate: '2026-07-01',
  validUntil: '2026-07-29',
  digitalFolder: { id: 'd', name: 'Rechnungen', path: '/Rechnungen/' },
  paperFolder: { folderId: 'f', register: 'A', label: 'Rechnungen' },
  tags: [],
  linkedCompany: 'Test GmbH',
  linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Bad' },
  archived: true,
  classifiedKind: 'rechnung',
  createdAt: '2026-01-01T12:00:00.000Z',
};

const issueDateOnly: CompanyDocument = {
  ...testInvoice,
  id: 'doc-issue-only',
  title: 'Schreiben',
  recognizedText: 'Allgemeines Schreiben ohne Aufforderung.',
  issueDate: '2026-07-29',
  validUntil: null,
  classifiedKind: 'sonstiges',
};

describe('DOCUMENT-FREE-QUESTION-EVIDENCE-01', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    vi.restoreAllMocks();
  });

  it('erkennt test_or_sample in DE/TR/BG', () => {
    expect(detectDocumentNature({ title: 'Testrechnung', recognizedText: '' })).toBe(
      'test_or_sample',
    );
    expect(
      detectDocumentNature({ title: 'Fatura', recognizedText: 'Bu bir örnek fatura. Gerçek bir alacak değil.' }),
    ).toBe('test_or_sample');
    expect(
      detectDocumentNature({ title: 'Фактура', recognizedText: 'Това е тестова фактура. Няма истинско вземане.' }),
    ).toBe('test_or_sample');
    expect(detectDocumentNature({ title: 'Mahnung', recognizedText: 'Zahlungsaufforderung' })).toBe(
      'unknown',
    );
  });

  it('noDeadline wird nicht durch issueDate unterdrückt', () => {
    const context = buildDocumentAiContextFromDocument(issueDateOnly);
    expect(context.issueDate).toBe('2026-07-29');
    expect(hasStructuredDeadlineEvidence(context)).toBe(false);
    expect(context.missingFieldNotes.some((n) => /Frist|süre|срок/i.test(n))).toBe(true);
  });

  it('Testrechnung + Fristfrage: Datum ok, keine Zahlungspflicht', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Die Frist für die Überweisung des Rechnungsbetrags ist der 29.07.2026.',
          explanation: 'Im Dokument steht wörtlich: „Überweisen Sie bis 29.07.2026.“',
        }),
      }),
    );
    const answer = await askDocumentAi({
      source: { type: 'document', document: testInvoice },
      question: 'Bis wann muss ich reagieren?',
    });
    expect(answer.directAnswer).not.toMatch(/Sie müssen|zahlungspflicht|Überweisung des Rechnungsbetrags ist/i);
    expect(answer.directAnswer).toMatch(/29\.07\.2026|Test|Muster|keine echte Forderung/i);
    expect(answer.uncertaintyNotes?.some((n) => /Test|Muster|Entwurf|örnek|тест/i.test(n))).toBe(
      true,
    );
  });

  it('Testrechnung + Zahlungsfrage: keine echte Forderung', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Nein. Das Dokument kennzeichnet sich als Testrechnung ohne echte Forderung.',
          explanation: 'Laut Hinweis im Dokument soll nicht bezahlt werden.',
        }),
      }),
    );
    const answer = await askDocumentAi({
      source: { type: 'document', document: testInvoice },
      question: 'Muss ich das bezahlen?',
    });
    expect(answer.directAnswer).toMatch(/Test|keine echte Forderung|nicht bezahlen/i);
    expect(answer.directAnswer).not.toMatch(/Sie müssen zahlen/i);
  });

  it('Datum nur als issueDate: keine Zahlungsfrist behaupten', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Die Zahlungsfrist ist der 2026-07-29.',
          explanation: 'Abgeleitet vom Ausstellungsdatum.',
        }),
      }),
    );
    const answer = await askDocumentAi({
      source: { type: 'document', document: issueDateOnly },
      question: 'Bis wann muss ich zahlen?',
    });
    expect(answer.source).toBe('ai');
    expect(answer.directAnswer).not.toMatch(/Zahlungsfrist ist|Sie müssen/i);
    expect(answer.directAnswer).toMatch(/genannt|nicht eindeutig|Testdokument|Frist/i);
  });

  it('OCR-Datum ohne Aufforderung: nur Nennung', () => {
    const context: DocumentAiContext = {
      ...buildDocumentAiContextFromDocument({
        ...issueDateOnly,
        title: 'Notiz',
        recognizedText: 'Besprechung am 29.07.2026 im Büro.',
        issueDate: null,
        validUntil: null,
      }),
    };
    expect(canClaimDocumentDemandWithDate(context)).toBe(false);
    const checked = applyDocumentAiAnswerPostCheck({
      question: 'Bis wann muss ich reagieren?',
      parsed: parseDocumentAiAnswer(
        JSON.stringify({
          directAnswer: 'Das Dokument fordert eine Zahlung bis zum 29.07.2026.',
          explanation: 'Im Text steht das Datum.',
        }),
      ),
      context,
      lang: 'de',
    });
    expect(checked.directAnswer).toMatch(/genannt|nicht eindeutig/i);
    expect(checked.directAnswer).not.toMatch(/fordert eine Zahlung|Sie müssen/i);
  });

  it('klare Mahnung: Dokument fordert Zahlung, nie Sie müssen', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Das Dokument fordert eine Zahlung bis zum 29.07.2026.',
          explanation: 'Im Text ist eine Zahlungsaufforderung mit Datum genannt.',
        }),
      }),
    );
    const answer = await askDocumentAi({
      source: { type: 'document', document: mahnung },
      question: 'Bis wann muss ich zahlen?',
    });
    expect(answer.directAnswer).toMatch(/fordert eine Zahlung|29\.07\.2026/i);
    expect(answer.directAnswer).not.toMatch(/Sie müssen|verpflichtet|verbindlich/i);
  });

  it('klare Mahnung mit Pflichtformulierung wird entschärft', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: JSON.stringify({
          directAnswer: 'Sie müssen bis zum 29.07.2026 zahlen.',
          explanation: 'Die Forderung ist verbindlich.',
        }),
      }),
    );
    const answer = await askDocumentAi({
      source: { type: 'document', document: mahnung },
      question: 'Muss ich das bezahlen?',
    });
    expect(answer.directAnswer).not.toMatch(/Sie müssen|verbindlich/i);
    expect(answer.directAnswer).toMatch(/fordert eine Zahlung|genannt/i);
  });

  it('Reaktionsaufforderung + Datum darf Stufe 2 beschreiben', () => {
    const context = buildDocumentAiContextFromDocument({
      ...mahnung,
      recognizedText:
        'Bitte antworten Sie bis 15.08.2026 und reichen Sie die Unterlagen ein. Reaktionsfrist 15.08.2026.',
      validUntil: '2026-08-15',
    });
    expect(canClaimDocumentDemandWithDate(context)).toBe(true);
  });

  it('erfundenes Zitat wird entfernt', () => {
    const context = buildDocumentAiContextFromDocument(testInvoice);
    const checked = applyDocumentAiAnswerPostCheck({
      question: 'Was steht im Dokument?',
      parsed: parseDocumentAiAnswer(
        JSON.stringify({
          directAnswer: 'Hinweis vorhanden.',
          explanation: 'Im Dokument steht wörtlich: „Überweisen Sie den Betrag sofort an Konto X.“',
        }),
      ),
      context,
      lang: 'de',
    });
    expect(checked.explanation).not.toMatch(/Überweisen Sie den Betrag sofort an Konto X/i);
    expect(checked.warnings).toContain('unverified_quote_removed');
  });

  it('verifizierter Text ohne Anführungszeichen bleibt paraphrasierbar', () => {
    const context = buildDocumentAiContextFromDocument(testInvoice);
    const phrase = 'Es besteht keine echte Forderung';
    const checked = applyDocumentAiAnswerPostCheck({
      question: 'Muss ich das bezahlen?',
      parsed: {
        directAnswer: 'Nein.',
        explanation: `Laut Hinweis: „${phrase}.“ Bitte nicht bezahlen.`,
        text: `Nein.\n\nLaut Hinweis: „${phrase}.“ Bitte nicht bezahlen.`,
      },
      context,
      lang: 'de',
    });
    // Quote marks removed; contiguous source phrase may remain as paraphrase text.
    expect(checked.explanation).toContain('keine echte Forderung');
    expect(checked.explanation).not.toMatch(/[„“”«»"]/);
  });

  it('DE/TR/BG Evidence-Keys vorhanden', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('document.freeQuestion.note.testOrSample', lang).length).toBeGreaterThan(0);
      expect(t('document.freeQuestion.direct.dateMentioned', lang)).toContain('{date}');
      expect(t('document.freeQuestion.direct.documentDemandsPayment', lang)).toContain('{date}');
    }
  });
});
