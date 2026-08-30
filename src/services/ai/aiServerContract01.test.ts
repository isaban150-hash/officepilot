/**
 * SECURITY-GEMINI-KEY-01B — die Serverregeln, hier echt geprüft.
 *
 * Der Vertrag der Edge Function liegt bewusst als reines TypeScript in
 * `supabase/functions/_shared/aiContract.ts` — ohne Deno-APIs. Dadurch laufen
 * Operationsprüfung, Größengrenzen, Zugriffsentscheidung, Limitkonfiguration
 * und Fehlerabbildung in dieser Testumgebung **wirklich**, statt erst nach
 * einem Deployment prüfbar zu sein.
 *
 * Nicht hier prüfbar und ausdrücklich dem Remote-Realtest vorbehalten: die
 * Token-Validierung, die Datenbankabfragen und die tatsächliche Nebenläufigkeit
 * der Zählung.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_HTTP_STATUS,
  AI_MAX_PROMPT_CHARS,
  AI_MAX_REQUEST_BYTES,
  AI_MODEL_BY_OPERATION,
  AI_OPERATIONS,
  AI_UPSTREAM_TIMEOUT_MS,
  buildGeminiEndpoint,
  evaluateProfileAccess,
  extractGeminiText,
  isAiOperation,
  mapUpstreamStatus,
  resolveRateLimitConfig,
  validateAiRequest,
} from '../../../supabase/functions/_shared/aiContract';

const WORKSPACE = '123e4567-e89b-12d3-a456-426614174000';

function request(overrides: Record<string, unknown> = {}) {
  return { operation: 'assistant', workspaceId: WORKSPACE, prompt: 'Frage', ...overrides };
}

describe('KI-Endpunkt: Anfragevertrag', () => {
  it('kennt genau die fünf produktiven Operationen', () => {
    expect([...AI_OPERATIONS].sort()).toEqual([
      'assistant',
      'communication_draft',
      'document_facts',
      'document_question',
      'vorgang_question',
    ]);
  });

  it('weist unbekannte Operationen ab', () => {
    for (const operation of ['', 'translate', 'image', 'assistant ', 'ASSISTANT', 42, null]) {
      expect(isAiOperation(operation)).toBe(false);
      expect(validateAiRequest(request({ operation }))).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    }
  });

  it('verlangt eine echte Workspace-Kennung', () => {
    for (const workspaceId of ['', 'nicht-uuid', '../andere', 123, undefined]) {
      expect(validateAiRequest(request({ workspaceId }))).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    }
  });

  it('weist leere Prompts ab', () => {
    for (const prompt of ['', '   ', undefined, 42]) {
      expect(validateAiRequest(request({ prompt }))).toEqual({
        ok: false,
        error: 'invalid_request',
      });
    }
  });

  it('verwirft alles, was nicht zum Vertrag gehört', () => {
    /*
     * Der Kern des operationsbasierten Entwurfs: Ein mitgeschicktes Modell,
     * ein Schlüssel oder eine Generationskonfiguration haben keine Wirkung,
     * weil sie gar nicht erst gelesen werden.
     */
    const result = validateAiRequest(
      request({
        model: 'gemini-1.5-pro',
        apiKey: 'egal',
        generationConfig: { temperature: 2 },
        userId: 'fremde-kennung',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.request).sort()).toEqual(['operation', 'prompt', 'workspaceId']);
  });

  it('begrenzt die Promptlänge je Operation', () => {
    for (const operation of AI_OPERATIONS) {
      const limit = AI_MAX_PROMPT_CHARS[operation];

      expect(validateAiRequest(request({ operation, prompt: 'x'.repeat(limit) }).valueOf()).ok).toBe(
        true,
      );
      expect(validateAiRequest(request({ operation, prompt: 'x'.repeat(limit + 1) }))).toEqual({
        ok: false,
        error: 'payload_too_large',
      });
    }
    // Die heutige Client-Grenze aus documentFactAiService bleibt unverändert.
    expect(AI_MAX_PROMPT_CHARS.document_facts).toBe(16000);
    expect(AI_MAX_REQUEST_BYTES).toBe(64 * 1024);
  });
});

describe('KI-Endpunkt: Zugriffsentscheidung', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('lässt nur freigegebene Konten mit aktiver Lizenz zu', () => {
    expect(
      evaluateProfileAccess({ status: 'approved', license_status: 'active' }, now),
    ).toEqual({ allowed: true });
  });

  it('weist pending und blocked ab', () => {
    for (const status of ['pending', 'blocked']) {
      expect(evaluateProfileAccess({ status, license_status: 'active' }, now)).toEqual({
        allowed: false,
        error: 'forbidden',
      });
    }
  });

  it('weist inactive und expired ab', () => {
    for (const license_status of ['inactive', 'expired']) {
      expect(evaluateProfileAccess({ status: 'approved', license_status }, now)).toEqual({
        allowed: false,
        error: 'license_inactive',
      });
    }
  });

  it('achtet auf das Ablaufdatum', () => {
    expect(
      evaluateProfileAccess(
        {
          status: 'approved',
          license_status: 'active',
          license_expires_at: '2026-09-02T00:00:00.000Z',
        },
        now,
      ),
    ).toEqual({ allowed: true });

    expect(
      evaluateProfileAccess(
        {
          status: 'approved',
          license_status: 'active',
          license_expires_at: '2026-08-31T00:00:00.000Z',
        },
        now,
      ),
    ).toEqual({ allowed: false, error: 'license_inactive' });
  });

  it('ist fail closed: unbekannte Werte und fehlendes Profil sperren', () => {
    for (const profile of [
      null,
      undefined,
      {},
      { status: 'irgendwas', license_status: 'active' },
      { status: 'approved', license_status: 'irgendwas' },
      { status: 'approved', license_status: 'active', license_expires_at: 'kein-datum' },
    ]) {
      expect(evaluateProfileAccess(profile, now).allowed).toBe(false);
    }
  });
});

describe('KI-Endpunkt: Limitkonfiguration', () => {
  const COMPLETE = {
    AI_RATE_LIMIT_SHORT_WINDOW_SECONDS: '60',
    AI_RATE_LIMIT_SHORT: '20',
    AI_RATE_LIMIT_DAILY: '500',
  };

  it('verweigert den Dienst, wenn gar nichts gesetzt ist', () => {
    /*
     * Kein stiller Standardwert: Ein Limit, das niemand gewählt hat, sieht im
     * Betrieb wie ein gesetztes aus. Ein vergessenes Secret soll auffallen.
     */
    expect(resolveRateLimitConfig({})).toEqual({ ok: false, error: 'server_misconfigured' });
  });

  it('verweigert den Dienst, wenn ein einzelner Wert fehlt oder leer ist', () => {
    for (const missing of Object.keys(COMPLETE)) {
      // Feld ganz weggelassen …
      const withoutKey = { ...COMPLETE } as Record<string, string | undefined>;
      delete withoutKey[missing];
      expect(resolveRateLimitConfig(withoutKey), missing).toEqual({
        ok: false,
        error: 'server_misconfigured',
      });

      // … und Feld gesetzt, aber leer.
      expect(resolveRateLimitConfig({ ...COMPLETE, [missing]: '' }), missing).toEqual({
        ok: false,
        error: 'server_misconfigured',
      });
      expect(resolveRateLimitConfig({ ...COMPLETE, [missing]: '   ' }), missing).toEqual({
        ok: false,
        error: 'server_misconfigured',
      });
    }
  });

  it('übernimmt gesetzte Werte', () => {
    const result = resolveRateLimitConfig({
      AI_RATE_LIMIT_SHORT_WINDOW_SECONDS: '30',
      AI_RATE_LIMIT_SHORT: '5',
      AI_RATE_LIMIT_DAILY: '100',
    });
    expect(result).toEqual({
      ok: true,
      config: { shortWindowSeconds: 30, shortWindowLimit: 5, dailyLimit: 100 },
    });
  });

  it('weist ungültige Werte ab: nicht numerisch, nicht ganzzahlig, nicht positiv', () => {
    for (const bad of ['0', '-5', '-1', 'viele', '1.5', 'NaN', '1e3', '20px', '٢٠']) {
      expect(resolveRateLimitConfig({ ...COMPLETE, AI_RATE_LIMIT_SHORT: bad }), bad).toEqual({
        ok: false,
        error: 'server_misconfigured',
      });
    }
  });
});

describe('KI-Endpunkt: Modell, Fehler und Antwort', () => {
  it('legt das Modell serverseitig fest', () => {
    for (const operation of AI_OPERATIONS) {
      expect(AI_MODEL_BY_OPERATION[operation]).toBe('gemini-2.5-flash');
    }
  });

  it('baut den Endpunkt ohne Schlüssel in der Adresse', () => {
    const url = buildGeminiEndpoint('gemini-2.5-flash');
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).not.toContain('?');
    expect(url).not.toContain('key=');
  });

  it('bildet Upstream-Status auf eigene Codes ab', () => {
    expect(mapUpstreamStatus(504)).toBe('ai_timeout');
    expect(mapUpstreamStatus(408)).toBe('ai_timeout');
    for (const status of [400, 401, 403, 429, 500, 503]) {
      expect(mapUpstreamStatus(status)).toBe('ai_upstream_error');
    }
  });

  it('ordnet jedem Fehlercode einen sinnvollen HTTP-Status zu', () => {
    expect(AI_HTTP_STATUS.unauthenticated).toBe(401);
    expect(AI_HTTP_STATUS.forbidden).toBe(403);
    expect(AI_HTTP_STATUS.license_inactive).toBe(403);
    expect(AI_HTTP_STATUS.workspace_forbidden).toBe(403);
    expect(AI_HTTP_STATUS.rate_limited).toBe(429);
    expect(AI_HTTP_STATUS.payload_too_large).toBe(413);
    expect(AI_HTTP_STATUS.invalid_request).toBe(400);
  });

  it('liest die Antwort wie bisher aus', () => {
    expect(
      extractGeminiText({ candidates: [{ content: { parts: [{ text: ' Hallo ' }] } }] }),
    ).toBe('Hallo');
    expect(extractGeminiText({})).toBe('');
    expect(extractGeminiText(null)).toBe('');
  });

  it('hat ein endliches Zeitlimit', () => {
    expect(AI_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AI_UPSTREAM_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
