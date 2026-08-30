/// <reference types="vite/client" />

/*
 * SECURITY-GEMINI-KEY-01B: `VITE_GEMINI_API_KEY` und `VITE_GEMINI_MODEL` sind
 * entfallen. Der Schlüssel liegt jetzt ausschliesslich als Server-Secret
 * `GEMINI_API_KEY` bei der Edge Function; das Modell bestimmt der Server.
 * Alles mit `VITE_`-Präfix landet im ausgelieferten Bundle — dort gehört kein
 * Geheimnis hin.
 */
interface ImportMetaEnv {
  readonly VITE_BETA_TEST_MODE?: string;
  readonly VITE_ALLOW_DEFAULT_ADMIN?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
