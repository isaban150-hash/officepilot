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
  /** EINRICHTUNG-01 (AP5; N-06.1) — optionale Build-Kennung für die Versionsseite (kein Geheimnis). */
  readonly VITE_APP_BUILD_ID?: string;
  readonly VITE_APP_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
