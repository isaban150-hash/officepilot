import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAiRequest, setAiGenerateTextForTests } from './aiRequestRunner';
import * as supabaseLib from '../../lib/supabase';

describe('aiRequestRunner', () => {
  beforeEach(() => {
    /*
     * SECURITY-GEMINI-KEY-01B: „konfiguriert" hieß früher „ein Gemini-Schlüssel
     * liegt im Browser". Der Schlüssel liegt jetzt beim Server; maßgeblich ist
     * die Cloud-Verbindung.
     */
    setAiGenerateTextForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    vi.restoreAllMocks();
  });

  it('liefert unavailable ohne eingerichtete Cloud-Verbindung', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const generateMock = vi.fn();
    setAiGenerateTextForTests(generateMock);

    const result = await runAiRequest({ operation: 'assistant', prompt: 'Test' });

    expect(result.source).toBe('unavailable');
    expect(result.errorCode).toBe('missing_api_key');
    // Entscheidend unverändert: Es wird nichts gesendet.
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('liefert Mock-Erfolg', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({ success: true, text: 'Mock-Antwort' }),
    );

    const result = await runAiRequest({ operation: 'assistant', prompt: 'Test', skipGuard: true });

    expect(result.success).toBe(true);
    expect(result.source).toBe('ai');
    expect(result.text).toBe('Mock-Antwort');
  });

  it('liefert rule_fallback bei API-Fehler', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: false,
        errorCode: 'api_error',
        message: 'API nicht erreichbar',
      }),
    );

    const result = await runAiRequest({ operation: 'assistant', prompt: 'Test', guardProfile: 'qa' });

    expect(result.source).toBe('rule_fallback');
    expect(result.message).toContain('API nicht erreichbar');
  });

  it('liefert rule_fallback bei Guard-Verstoß', async () => {
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Das ist steuerlich absetzbar.',
      }),
    );

    const result = await runAiRequest({
      operation: 'assistant',
      prompt: 'Test',
      guardProfile: 'qa',
      guardContext: { allowedSourceText: 'Original' },
    });

    expect(result.source).toBe('rule_fallback');
    expect(result.errorCode).toBe('guard_rejected');
    expect(result.warnings?.[0]).toContain('Rechts-/Steuerformulierung');
  });
});
