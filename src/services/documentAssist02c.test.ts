/**
 * DOCUMENT-ASSIST-02C — targeted clarification without guessing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import {
  applyDocumentAiAnswerPostCheck,
  buildDocumentAiContextFromInbox,
  buildDocumentAiPrompt,
  DOCUMENT_AI_MAX_PRIOR_ROUNDS,
  shouldPersistDocumentAiConversationExchange,
} from './document/documentAiService';
import {
  countDocumentAiClarificationQuestionMarks,
  isGenuineDocumentAiClarificationAnswer,
  shouldSpareDocumentAiPostCheckSoftening,
} from './document/documentAiClarificationDetect';
import { setAiGenerateTextForTests } from './ai/aiRequestRunner';
import {
  buildDocumentWorkTruthViewForInboxItem,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';
import { DOCUMENT_WORK_RESULT_ANALYSIS_VERSION } from '../types/documentWorkResult';
import type { DocumentAiContext } from '../types/areaAi';

function seedHotelInbox() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  const item = getInboxItemById(observation.item.id)!;
  return { workflow, item };
}

function baseContext(overrides: Partial<DocumentAiContext> = {}): DocumentAiContext {
  return {
    sourceType: 'inbox',
    title: 'Rechnung',
    issuerOrSender: 'Hotel',
    category: 'rechnung',
    classifiedKind: 'rechnung',
    recognizedDataLines: [],
    missingDocuments: [],
    tags: [],
    uncertainFieldNotes: [],
    missingFieldNotes: [],
    ...overrides,
  };
}

describe('DOCUMENT-ASSIST-02C clarification', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setTaskStoreForTests([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCompanyProfileStore(testProfile);
    resetDocumentWorkResultStoreForTests();
    setAiGenerateTextForTests(null);
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
  });

  afterEach(() => {
    setAiGenerateTextForTests(null);
    resetDocumentWorkResultStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('Prompt enthält Entscheidung A–D und gezielte Rückfrage-/Teilzahlungsregeln', () => {
    const { workflow, item } = seedHotelInbox();
    const ctx = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const prompt = buildDocumentAiPrompt('Kann ich den Rest am Ersten zahlen?', ctx, 'de');
    expect(prompt).toMatch(/A\.\s*DIREKT ANTWORTEN/);
    expect(prompt).toMatch(/B\.\s*VORSICHTIG ANTWORTEN/);
    expect(prompt).toMatch(/C\.\s*GEZIELT NACHFRAGEN/);
    expect(prompt).toMatch(/D\.\s*NICHT FACHLICH BEANTWORTBAR/);
    expect(prompt).toContain('Restbetrag niemals erfinden');
    expect(prompt).toContain('höchstens 1–3 konkrete Rückfragen');
    expect(prompt).toContain('Bitte geben Sie alle relevanten Informationen an');
    expect(prompt).toContain('<<<NUTZERFRAGE_DATEN>>>');
    expect(prompt).toContain('untrusted');
    expect(prompt).toMatch(/02A|TruthView|BESTÄTIGTE NUTZERDATEN/);
  });

  it('eindeutige bestätigte Fakten: Prompt fordert Direktantwort ohne unnötige Rückfrage', () => {
    const { workflow, item } = seedHotelInbox();
    let dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.money.0',
      status: 'user_confirmed',
      value: {
        kind: 'other',
        amountFormatted: '1.200,00 EUR',
        certainty: 'proposed',
        source: 'understanding',
      },
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.timeline.deadline',
      status: 'user_confirmed',
      value: '15.08.2026',
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    upsertDocumentWorkResult(dwr);

    const ctx = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const prompt = buildDocumentAiPrompt('Wie viel muss ich bis wann bezahlen?', ctx, 'de');
    expect(prompt).toContain('1.200,00 EUR');
    expect(prompt).toContain('15.08.2026');
    expect(prompt).toMatch(/DIREKT ANTWORTEN/);
    expect(prompt).toMatch(/keine unnötige Rückfrage|keine bereits bekannte Information erneut/);
    expect(ctx.confirmedUserFactLines?.join('\n')).toMatch(/1\.200|15\.08/);
  });

  it('TruthView-Frist vor OCR: keine Rückfrage nur wegen OCR-Widerspruch', () => {
    const { workflow, item } = seedHotelInbox();
    const mutated = {
      ...item,
      recognizedData: { ...item.recognizedData, Frist: '05.08.2026' },
      deadline: '05.08.2026',
    };
    hydrateInboxStore([mutated]);
    const live = getInboxItemById(mutated.id)!;
    let dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: live,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.timeline.deadline',
      status: 'user_confirmed',
      value: '15.08.2026',
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    upsertDocumentWorkResult(dwr);

    const truth = buildDocumentWorkTruthViewForInboxItem({
      item: live,
      liveWorkflow: workflow,
    });
    expect(truth?.businessInterpretation?.facts.timeline.deadline?.value).toBe('15.08.2026');

    const ctx = buildDocumentAiContextFromInbox(live, { liveWorkflow: workflow });
    const prompt = buildDocumentAiPrompt('Wann ist die Frist?', ctx, 'de');
    expect(prompt).toContain('15.08.2026');
    expect(prompt).toMatch(/widersprechender OCR relativiert sie nicht/);
    expect(ctx.suppressStructuredDeadline).toBe(true);
  });

  it('Gesprächskontext für Entwurf: Prompt verhindert erneute Grundsatzfrage', () => {
    const { workflow, item } = seedHotelInbox();
    const ctx = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const prompt = buildDocumentAiPrompt('Schreib mir eine kurze Antwort.', ctx, 'de', {
      priorTurns: [
        {
          role: 'user',
          text: 'Ich möchte Zahlungsaufschub bis zum Ersten erbitten.',
        },
        {
          role: 'assistant',
          text: 'Das ist eine unbestätigte Absicht. Formulieren Sie gerne eine Bitte.',
          uncertain: true,
        },
      ],
    });
    expect(prompt).toContain('Zahlungsaufschub bis zum Ersten');
    expect(prompt).toMatch(/NICHT ERNEUT ABFRAGEN|bereits bekannte Information erneut/);
    expect(prompt).toContain('GESPRÄCHSVERLAUF');
  });

  it('Clarification-Detect: echte Klärung vs. bloßes Fragezeichen / Overclaim', () => {
    const genuine =
      'Im Dokument ist der bereits gezahlte Betrag nicht bekannt. Wie viel haben Sie bereits bezahlt und an welchem Tag?';
    expect(isGenuineDocumentAiClarificationAnswer(genuine)).toBe(true);
    expect(shouldSpareDocumentAiPostCheckSoftening(genuine)).toBe(true);
    expect(countDocumentAiClarificationQuestionMarks(genuine)).toBeLessThanOrEqual(3);

    expect(isGenuineDocumentAiClarificationAnswer('Was meinen Sie?')).toBe(false);
    expect(isGenuineDocumentAiClarificationAnswer('Bitte?')).toBe(false);
    expect(
      isGenuineDocumentAiClarificationAnswer(
        'Sie müssen bis Freitag zahlen. Welchen Betrag haben Sie bereits gezahlt?',
      ),
    ).toBe(false);
  });

  it('Post-Check erhält echte Klärungsantwort und softet Overclaim trotz Fragezeichen', () => {
    const ctx = baseContext({
      issueDate: '2026-01-01',
      recognizedText: 'Rechnung ohne klare Frist',
    });

    const clarifying = applyDocumentAiAnswerPostCheck({
      question: 'Kann ich den Rest am Ersten zahlen?',
      parsed: {
        directAnswer:
          'Der bereits gezahlte Betrag ist nicht bekannt. Wie viel haben Sie bereits bezahlt?',
        explanation: 'Ohne Teilzahlung kann kein Restbetrag genannt werden.',
        text: '',
      },
      context: ctx,
      lang: 'de',
    });
    expect(clarifying.directAnswer).toMatch(/bereits bezahlt/i);
    expect(clarifying.softened).toBe(false);

    const overclaim = applyDocumentAiAnswerPostCheck({
      question: 'Muss ich zahlen?',
      parsed: {
        directAnswer: 'Sie müssen bis Freitag zahlen. Welchen Betrag meinen Sie?',
        explanation: 'Bitte prüfen.',
        text: '',
      },
      context: ctx,
      lang: 'de',
    });
    expect(overclaim.softened).toBe(true);
    expect(overclaim.warnings).toContain('forbidden_user_obligation');
    expect(overclaim.directAnswer).not.toMatch(/Sie müssen/i);

    const bareQuestion = applyDocumentAiAnswerPostCheck({
      question: 'Frist?',
      parsed: {
        directAnswer: 'Das Dokument fordert eine Zahlung bis zum 01.01.2026?',
        explanation: 'Unklar.',
        text: '',
      },
      context: { ...ctx, issueDate: '2026-01-01' },
      lang: 'de',
    });
    expect(bareQuestion.softened).toBe(true);
  });

  it('unavailable wird nicht persistiert; erfolgreiche AI-Antwort schon', () => {
    expect(
      shouldPersistDocumentAiConversationExchange({
        source: 'unavailable',
      }),
    ).toBe(false);
    expect(
      shouldPersistDocumentAiConversationExchange({
        source: 'ai',
      }),
    ).toBe(true);
  });

  it('02B Cap und Immutabilität bleiben; keine Storage-Writes durch Clarification-Helper', () => {
    expect(DOCUMENT_AI_MAX_PRIOR_ROUNDS).toBe(4);
    const ssSet = vi.spyOn(Storage.prototype, 'setItem');
    const before = [{ role: 'user' as const, text: 'x' }];
    const snap = JSON.stringify(before);
    void isGenuineDocumentAiClarificationAnswer(
      'Der gezahlte Betrag fehlt. Wie viel haben Sie bereits bezahlt?',
    );
    expect(JSON.stringify(before)).toBe(snap);
    const writes = ssSet.mock.calls.filter(([key]) =>
      String(key).includes('document-ai') || String(key).includes('conversation'),
    );
    expect(writes).toHaveLength(0);
  });

  it('keine TruthView-Änderung durch Prompt-Bau mit Chat-Teilzahlung', () => {
    const { workflow, item } = seedHotelInbox();
    let dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.money.0',
      status: 'user_confirmed',
      value: {
        kind: 'other',
        amountFormatted: '1.200,00 EUR',
        certainty: 'proposed',
        source: 'understanding',
      },
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    upsertDocumentWorkResult(dwr);

    const before = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
    });
    const money = before?.businessInterpretation?.facts.money[0]?.amountFormatted;
    const ctx = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    buildDocumentAiPrompt('Ich habe schon etwas bezahlt. Rest am Ersten?', ctx, 'de', {
      priorTurns: [{ role: 'user', text: 'Ich habe schon etwas bezahlt.' }],
    });
    const after = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
    });
    expect(after?.businessInterpretation?.facts.money[0]?.amountFormatted).toBe(money);
    expect(money).toContain('1.200');
  });
});
