/**
 * DOCUMENT-ASSIST-02B — ephemeral document-bound dialog continuity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import {
  askDocumentAi,
  buildDocumentAiContextFromInbox,
  buildDocumentAiPrompt,
  buildDocumentAiPriorTurnsGuardText,
  DOCUMENT_AI_MAX_PRIOR_ROUNDS,
  DOCUMENT_AI_MAX_TURN_CHARS,
  formatDocumentAiPriorTurnsForPrompt,
  normalizeDocumentAiPriorTurns,
} from './document/documentAiService';
import { validateAiOutput } from './ai/aiOutputGuardService';
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
import type { DocumentAiPriorTurn } from '../types/areaAi';

function seedHotelInbox() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  const item = getInboxItemById(observation.item.id)!;
  return { workflow, item };
}

describe('DOCUMENT-ASSIST-02B conversation continuity', () => {
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

  it('Folgefrage-Prompt enthält vorherigen User- und Assistant-Turn', () => {
    const { workflow, item } = seedHotelInbox();
    const ctx = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const prior: DocumentAiPriorTurn[] = [
      { role: 'user', text: 'Ich habe schon 300 Euro bezahlt.' },
      {
        role: 'assistant',
        text: 'Das Dokument nennt einen Gesamtbetrag. Ihre Zahlung ist unbestätigt.',
        uncertain: true,
        uncertaintyNotes: ['Betrag prüfen'],
      },
    ];
    const prompt = buildDocumentAiPrompt('Wie viel ist dann noch offen?', ctx, 'de', {
      priorTurns: prior,
    });
    expect(prompt).toContain('GESPRÄCHSVERLAUF');
    expect(prompt).toContain('Ich habe schon 300 Euro bezahlt.');
    expect(prompt).toContain('Gesamtbetrag');
    expect(prompt).toContain('UNSICHER');
    expect(prompt).toMatch(/TruthView hat Vorrang|Vorrang vor OCR und Chat/);
  });

  it('User-Betrag aus vorherigem Turn ist im Guard-Kontext; Assistant-Vermutung nicht', () => {
    const prior: DocumentAiPriorTurn[] = [
      { role: 'user', text: 'Ich habe 300 € bezahlt.' },
      {
        role: 'assistant',
        text: 'Vermutlich sind dann noch 50 € offen.',
        uncertain: true,
      },
    ];
    const guardText = buildDocumentAiPriorTurnsGuardText(prior);
    expect(guardText).toContain('300');
    expect(guardText).not.toContain('50');
    expect(guardText).not.toContain('Vermutlich');

    const allowed = `Dokumentbetrag 500,00 €\n${guardText}`;
    const okUserAmount = validateAiOutput(
      '{"directAnswer":"Noch offen laut Dialog: 300 € wurden genannt.","explanation":"Unbestätigt."}',
      'qa',
      { allowedSourceText: allowed },
    );
    expect(okUserAmount.valid).toBe(true);

    const rejectAssistantOnlyAmount = validateAiOutput(
      '{"directAnswer":"Noch 50 € offen.","explanation":"Aus Vermutung."}',
      'qa',
      { allowedSourceText: allowed },
    );
    expect(rejectAssistantOnlyAmount.valid).toBe(false);
  });

  it('unsichere Assistant-Antwort bleibt als unsicher gekennzeichnet', () => {
    const lines = formatDocumentAiPriorTurnsForPrompt([
      {
        role: 'assistant',
        text: 'Vermutlich ist eine Zahlung am Ersten möglich.',
        uncertain: true,
        uncertaintyNotes: ['Keine verbindliche Freigabe'],
      },
    ]);
    expect(lines.join('\n')).toContain('UNSICHER');
    expect(lines.join('\n')).toContain('Keine verbindliche Freigabe');
  });

  it('maximale Turn-Anzahl und Kürzung sind deterministisch; Inputs unverändert', () => {
    const long = 'X'.repeat(DOCUMENT_AI_MAX_TURN_CHARS + 40);
    const many: DocumentAiPriorTurn[] = [];
    for (let i = 0; i < DOCUMENT_AI_MAX_PRIOR_ROUNDS + 2; i += 1) {
      many.push({ role: 'user', text: `user-${i}-${long}` });
      many.push({ role: 'assistant', text: `asst-${i}` });
    }
    const before = JSON.stringify(many);
    const a = normalizeDocumentAiPriorTurns(many);
    const b = normalizeDocumentAiPriorTurns(many);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBe(DOCUMENT_AI_MAX_PRIOR_ROUNDS * 2);
    expect(a[0]?.text.startsWith('user-2')).toBe(true);
    expect(a.every((t) => t.text.length <= DOCUMENT_AI_MAX_TURN_CHARS + 1)).toBe(true);
    expect(JSON.stringify(many)).toBe(before);
  });

  it('Verlauf überschreibt TruthView nicht; 02A-Fakten bleiben vor Chat', () => {
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
        amountFormatted: '999,00 EUR',
        certainty: 'proposed',
        source: 'understanding',
      },
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    upsertDocumentWorkResult(dwr);

    const truthBefore = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
    });
    const moneyBefore =
      truthBefore?.businessInterpretation?.facts.money[0]?.amountFormatted ?? '';

    const ctx = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const prompt = buildDocumentAiPrompt('Rest?', ctx, 'de', {
      priorTurns: [{ role: 'user', text: 'Ich habe 300 Euro bezahlt.' }],
    });

    const truthAfter = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
    });
    expect(truthAfter?.businessInterpretation?.facts.money[0]?.amountFormatted).toBe(
      moneyBefore,
    );
    expect(prompt.indexOf('1. BESTÄTIGTE NUTZERDATEN')).toBeLessThan(
      prompt.indexOf('5. GESPRÄCHSVERLAUF'),
    );
    expect(prompt).toContain('999,00 EUR');
    expect(ctx.confirmedUserFactLines?.some((l) => l.includes('999'))).toBe(true);
  });

  it('askDocumentAi übergibt priorTurns an Prompt und nutzt keinen Storage', async () => {
    const { workflow, item } = seedHotelInbox();
    const ssSet = vi.spyOn(Storage.prototype, 'setItem');
    setAiGenerateTextForTests(async () => ({
      success: true,
      text: JSON.stringify({
        directAnswer: 'Offen laut Dialog unbestätigt.',
        explanation: 'Ihre 300-Euro-Angabe ist Gesprächskontext.',
      }),
    }));

    const answer = await askDocumentAi({
      source: { type: 'inbox', item, liveWorkflow: workflow },
      question: 'Wie viel ist noch offen?',
      priorTurns: [{ role: 'user', text: 'Ich habe schon 300 Euro bezahlt.' }],
    });

    expect(answer.source).toBe('ai');
    expect(answer.text.length).toBeGreaterThan(0);

    const storageWrites = ssSet.mock.calls.filter(
      ([key]) =>
        String(key).includes('conversation') ||
        String(key).includes('document-ai') ||
        String(key).includes('free-question'),
    );
    expect(storageWrites).toHaveLength(0);
  });

  it('Dokumentisolation: getrennte priorTurns-Snapshots A≠B im Prompt', () => {
    const { workflow, item } = seedHotelInbox();
    const otherCase = getDocumentCase('HOTEL-01');
    const otherObs = runStablePipeline(otherCase);
    const otherItem = { ...otherObs.item, id: `${otherObs.item.id}-b`, title: 'Dokument B' };
    hydrateInboxStore([item, otherItem]);
    const otherWorkflow = processUploadedDocument(otherItem.id)!;

    const promptA = buildDocumentAiPrompt(
      'Folge A?',
      buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow }),
      'de',
      { priorTurns: [{ role: 'user', text: 'Nur Geheimnis A-123' }] },
    );
    const promptB = buildDocumentAiPrompt(
      'Folge B?',
      buildDocumentAiContextFromInbox(otherItem, { liveWorkflow: otherWorkflow }),
      'de',
      { priorTurns: [{ role: 'user', text: 'Nur Geheimnis B-999' }] },
    );

    expect(promptA).toContain('Nur Geheimnis A-123');
    expect(promptA).not.toContain('Nur Geheimnis B-999');
    expect(promptB).toContain('Nur Geheimnis B-999');
    expect(promptB).not.toContain('Nur Geheimnis A-123');
  });
});
