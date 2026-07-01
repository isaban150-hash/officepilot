import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { getAllVorgaenge, hydrateVorgangStore } from '../vorgangService';
import { setTaskStoreForTests } from '../taskStore';
import { normalizeTask } from '../taskNormalize';
import { hydrateVorgangNotes } from '../vorgangNoteService';
import { askVorgangAi, buildVorgangAiContext, buildVorgangAiPrompt } from './vorgangAiService';
import { setAiGenerateTextForTests } from '../ai/aiRequestRunner';
import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';

describe('vorgangAiService', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiGenerateTextForTests(null);
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-ai-test',
        title: 'Dachsanierung',
        customer: 'Müller GmbH',
        baustelle: 'Berlin Mitte',
        status: 'in_bearbeitung',
        invoices: [
          {
            id: 'inv-ai-1',
            number: '2026-0100',
            type: 'schluss',
            positions: [],
            subtotal: 1000,
            taxStatus: 'standard_19',
            amount: 1190,
            status: 'versendet',
            date: '2026-06-01',
            createdAt: '2026-06-01T00:00:00.000Z',
            paymentDueDate: '2026-07-15',
          },
        ],
      }),
    ]);
    hydrateVorgangNotes([
      {
        id: 'note-ai-1',
        vorgangId: 'v-ai-test',
        vorgangTitle: 'Dachsanierung',
        body: 'Kunde hat angerufen',
        occurredAt: '2026-06-20T10:00:00.000Z',
        createdAt: '2026-06-20T10:00:00.000Z',
        source: 'user',
      },
    ]);
    setTaskStoreForTests([
      normalizeTask({
        id: 'task-ai-1',
        title: 'Angebot nachreichen',
        description: 'Test',
        status: 'open',
        priority: 'mittel',
        category: 'dokumente',
        type: 'dokument_pruefen',
        linkedVorgangId: 'v-ai-test',
        done: false,
      }),
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    vi.restoreAllMocks();
  });

  it('Prompt enthält Vorgangsdaten und Guardrails', () => {
    const context = buildVorgangAiContext('v-ai-test');
    expect(context).not.toBeNull();
    const prompt = buildVorgangAiPrompt('Was ist offen?', context!);

    expect(prompt).toContain(AI_QA_SYSTEM_RULES);
    expect(prompt).toContain('Dachsanierung');
    expect(prompt).toContain('Müller GmbH');
    expect(prompt).toContain('Kunde hat angerufen');
    expect(prompt).toContain('2026-0100');
    expect(prompt).toContain('Angebot nachreichen');
  });

  it('Prompt enthält keine globalen Brain-Daten', () => {
    const context = buildVorgangAiContext('v-ai-test');
    const prompt = buildVorgangAiPrompt('Welche Aufgaben hängen dran?', context!);

    expect(prompt).not.toContain('Kommunikationshistorie');
    expect(prompt).not.toContain('Ausgaben offen');
  });

  it('liefert Mock-Antwort und mutiert keine Stores', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Offen ist Rechnung 2026-0100 und die Aufgabe Angebot nachreichen.',
      }),
    );

    const before = JSON.stringify(getAllVorgaenge());
    const answer = await askVorgangAi({
      vorgangId: 'v-ai-test',
      question: 'Was ist offen?',
    });
    const after = JSON.stringify(getAllVorgaenge());

    expect(answer.source).toBe('ai');
    expect(answer.text).toContain('2026-0100');
    expect(after).toBe(before);
  });
});
