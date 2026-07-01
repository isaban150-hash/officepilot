export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export function getGeminiApiKey(): string | undefined {
  const viteKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (typeof viteKey === 'string' && viteKey.trim()) {
    return viteKey.trim();
  }
  return undefined;
}

export function getGeminiModel(): string {
  const viteModel = import.meta.env.VITE_GEMINI_MODEL;
  if (typeof viteModel === 'string' && viteModel.trim()) {
    return viteModel.trim();
  }
  return DEFAULT_GEMINI_MODEL;
}

export function isGeminiConfigured(): boolean {
  return Boolean(getGeminiApiKey());
}
