/**
 * SECURITY-GEMINI-KEY-01B — der KI-Zugang des Clients.
 *
 * Diese Datei prüfte bis 01B den direkten Gemini-Aufruf: Schlüssel aus
 * `VITE_GEMINI_API_KEY`, Anfrage an `generativelanguage.googleapis.com`. Genau
 * dieses Verhalten war die Schwachstelle und ist entfallen; die Zusicherungen
 * sind deshalb auf den neuen Weg umgeschrieben, nicht gestrichen.
 *
 * Erhalten geblieben ist alles, was fachlich weiter gilt: leerer Prompt ohne
 * Netzaufruf, verständliche deutsche Fehlermeldungen, kein technischer
 * Fremdtext beim Nutzer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, isAiProviderConfigured, setAiProviderFetchForTests } from './aiProviderService';
import { hydrateSyncClient, createSyncClient, resetSyncClientForTests } from './sync/syncClientService';
import { loginAsDefaultAdmin, seedDefaultAdminUser } from '../test/authFixtures';

const WORKSPACE = '123e4567-e89b-12d3-a456-426614174000';

function proxyResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body });
}

describe('aiProviderService (KI über den OfficePilot-Endpunkt)', () => {
  beforeEach(async () => {
    // Der Endpunkt verlangt eine Sitzung — ohne sie wird gar nicht gesendet.
    await seedDefaultAdminUser();
    await loginAsDefaultAdmin();
    resetSyncClientForTests(createSyncClient());
    hydrateSyncClient({ ...createSyncClient(), serverWorkspaceId: WORKSPACE });
    setAiProviderFetchForTests(null);
  });

  afterEach(() => {
    setAiProviderFetchForTests(null);
    vi.restoreAllMocks();
  });

  it('lehnt leere Prompts ohne Netzaufruf ab', async () => {
    const fetchMock = proxyResponse({ ok: true, text: 'ungenutzt' });
    setAiProviderFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateText('assistant', '   ');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('invalid_prompt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendet weder Schlüssel noch Modell noch Generationsparameter', async () => {
    const fetchMock = proxyResponse({ ok: true, text: 'Antwort' });
    setAiProviderFetchForTests(fetchMock as unknown as typeof fetch);

    await generateText('assistant', 'Frage');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('generativelanguage.googleapis.com');
    expect(String(url)).toContain('/functions/v1/ai');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(['operation', 'prompt', 'workspaceId']);
    expect(body.operation).toBe('assistant');
    expect(body.workspaceId).toBe(WORKSPACE);
    // Weder ein Schlüssel noch eine Modellwahl noch eine Konfiguration.
    for (const forbidden of ['key', 'apiKey', 'model', 'generationConfig', 'safetySettings']) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(init)).not.toMatch(/x-goog-api-key/i);
  });

  it('gibt die Antwort des Endpunkts zurück', async () => {
    setAiProviderFetchForTests(
      proxyResponse({ ok: true, text: '  Ergebnis  ' }) as unknown as typeof fetch,
    );

    const result = await generateText('document_question', 'Frage');

    expect(result).toEqual({ success: true, text: 'Ergebnis' });
  });

  it('bildet Serverfehler auf verständliche deutsche Meldungen ab', async () => {
    const cases: Array<[string, number, string]> = [
      ['rate_limited', 429, 'rate_limited'],
      ['payload_too_large', 413, 'payload_too_large'],
      ['ai_timeout', 504, 'ai_timeout'],
      ['license_inactive', 403, 'license_inactive'],
      ['workspace_forbidden', 403, 'workspace_forbidden'],
      ['unauthenticated', 401, 'unauthenticated'],
    ];

    for (const [serverError, status, expectedCode] of cases) {
      setAiProviderFetchForTests(
        proxyResponse({ ok: false, error: serverError }, false, status) as unknown as typeof fetch,
      );

      const result = await generateText('assistant', 'Frage');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errorCode).toBe(expectedCode);
      expect(result.message.length).toBeGreaterThan(0);
      // Kein technischer Fremdtext, kein englischer Rohtext.
      expect(result.message).not.toMatch(/api key|quota|RESOURCE_EXHAUSTED/i);
    }
  });

  it('behandelt einen Netzfehler ohne Rückfall auf Google', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    setAiProviderFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateText('assistant', 'Frage');

    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Genau ein Versuch: kein Retry, kein zweiter Weg.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('googleapis'))).toBe(true);
  });

  it('meldet fehlenden Workspace, statt ohne ihn zu senden', async () => {
    resetSyncClientForTests(createSyncClient());
    hydrateSyncClient({ ...createSyncClient(), serverWorkspaceId: undefined });
    const fetchMock = proxyResponse({ ok: true, text: 'x' });
    setAiProviderFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateText('assistant', 'Frage');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('workspace_forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hängt nicht mehr am Gemini-Schlüssel im Browser', () => {
    /*
     * Früher hieß „konfiguriert" = „ein Gemini-Schlüssel liegt im Bundle".
     * Diese Frage ergibt keinen Sinn mehr; ein serverseitiges Geheimnis ist im
     * Browser naturgemäß unsichtbar. Die Oberfläche darf KI-Funktionen nicht
     * deshalb verstecken.
     */
    vi.stubEnv('VITE_GEMINI_API_KEY', '');
    expect(isAiProviderConfigured()).toBe(true);
    vi.unstubAllEnvs();
  });
});
