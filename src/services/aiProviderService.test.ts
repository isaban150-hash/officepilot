import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateText,
  isAiProviderConfigured,
  setAiProviderFetchForTests,
} from './aiProviderService';

function mockGeminiResponse(text: string, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () =>
      ok
        ? {
            candidates: [{ content: { parts: [{ text }] } }],
          }
        : {
            error: { message: 'API quota exceeded', status: 'RESOURCE_EXHAUSTED' },
          },
  });
}

describe('aiProviderService', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiProviderFetchForTests(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiProviderFetchForTests(null);
    vi.restoreAllMocks();
  });

  it('reports missing configuration when API key is absent', async () => {
    vi.stubEnv('VITE_GEMINI_API_KEY', '');
    expect(isAiProviderConfigured()).toBe(false);

    const result = await generateText('Hallo');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('missing_api_key');
  });

  it('rejects empty prompts without calling the API', async () => {
    const fetchMock = mockGeminiResponse('unused');
    setAiProviderFetchForTests(fetchMock);

    const result = await generateText('   ');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('invalid_prompt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns generated text from mocked Gemini response', async () => {
    const fetchMock = mockGeminiResponse('Hallo von Gemini');
    setAiProviderFetchForTests(fetchMock);

    const result = await generateText('Sag Hallo');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.text).toBe('Hallo von Gemini');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('gemini-2.5-flash');
    expect(url).toContain('key=test-gemini-key');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('Sag Hallo');
  });

  it('handles API errors safely', async () => {
    setAiProviderFetchForTests(mockGeminiResponse('', false));

    const result = await generateText('Test');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('api_error');
    expect(result.message).toContain('Bitte versuchen Sie');
    expect(result.message).not.toContain('quota');
  });

  it('handles empty Gemini responses', async () => {
    setAiProviderFetchForTests(
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '  ' }] } }] }),
      }),
    );

    const result = await generateText('Test');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorCode).toBe('empty_response');
  });
});
