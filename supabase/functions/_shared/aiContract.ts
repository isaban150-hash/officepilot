/**
 * SECURITY-GEMINI-KEY-01B — der Vertrag des KI-Endpunkts.
 *
 * Bewusst **reines** TypeScript ohne Deno-APIs: So laufen dieselben Regeln, die
 * die Edge Function anwendet, auch in der vorhandenen Vitest-Umgebung. Ohne
 * das wären Operationsprüfung, Größengrenzen und Fehlerabbildung erst nach
 * einem Deployment prüfbar.
 *
 * Der Endpunkt ist **operationsbasiert**, nicht generisch. Ein offener
 * `{ prompt, model }`-Proxy wäre ein bezahlter Gemini-Zugang mit einem Login
 * davor — jeder angemeldete Nutzer könnte ihn für beliebige Zwecke verwenden.
 * Die Operation bestimmt hier serverseitig Modell, Größengrenze und
 * Zählklasse; der Client bestimmt nichts davon.
 */

/** Die fünf produktiven KI-Fachketten. Mehr gibt es nicht. */
export const AI_OPERATIONS = [
  'document_question',
  'document_facts',
  'communication_draft',
  'assistant',
  'vorgang_question',
] as const;

export type AiOperation = (typeof AI_OPERATIONS)[number];

export function isAiOperation(value: unknown): value is AiOperation {
  return typeof value === 'string' && (AI_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Das Modell wird ausschliesslich hier bestimmt. Ein manipulierter Browser
 * soll kein teureres Modell wählen können.
 */
export const AI_MODEL_BY_OPERATION: Record<AiOperation, string> = {
  document_question: 'gemini-2.5-flash',
  document_facts: 'gemini-2.5-flash',
  communication_draft: 'gemini-2.5-flash',
  assistant: 'gemini-2.5-flash',
  vorgang_question: 'gemini-2.5-flash',
};

/**
 * Zeichengrenzen je Operation.
 *
 * `document_facts` übernimmt die heute im Client geltende Grenze
 * (`MAX_PROMPT_PAYLOAD_CHARS = 16000`) unverändert. Die übrigen Ketten haben
 * clientseitig **keine** Grenze; sie bekommen hier eine grosszügige, aber
 * endliche — die Dialogketten begrenzen ihren Verlauf bereits auf vier Runden
 * à 600 Zeichen, der Rest ist Dokument- und Vorgangskontext.
 *
 * Die Werte sind bewusst weit gefasst: Sie sollen Missbrauch abwehren, nicht
 * legitime Anfragen abschneiden. Nach dem Pilotbetrieb sind sie anhand echter
 * Längen nachzuschärfen.
 */
export const AI_MAX_PROMPT_CHARS: Record<AiOperation, number> = {
  document_question: 24000,
  document_facts: 16000,
  communication_draft: 12000,
  assistant: 24000,
  vorgang_question: 24000,
};

/** Harte Obergrenze für den gesamten Rumpf, unabhängig von der Operation. */
export const AI_MAX_REQUEST_BYTES = 64 * 1024;

/** Kein unbegrenzt hängender Aufruf. */
export const AI_UPSTREAM_TIMEOUT_MS = 30_000;

export type AiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'license_inactive'
  | 'workspace_forbidden'
  | 'rate_limited'
  | 'payload_too_large'
  | 'ai_timeout'
  | 'ai_upstream_error'
  | 'ai_empty_response'
  | 'server_misconfigured'
  | 'unknown';

export const AI_HTTP_STATUS: Record<AiErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  license_inactive: 403,
  workspace_forbidden: 403,
  rate_limited: 429,
  payload_too_large: 413,
  ai_timeout: 504,
  ai_upstream_error: 502,
  ai_empty_response: 502,
  server_misconfigured: 500,
  unknown: 500,
};

export interface AiProxyRequest {
  operation: AiOperation;
  workspaceId: string;
  prompt: string;
}

export type AiRequestValidation =
  | { ok: true; request: AiProxyRequest }
  | { ok: false; error: AiErrorCode };

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Prüft den Rumpf. Alles, was nicht zum Vertrag gehört, wird **verworfen**,
 * nicht durchgereicht: Ein mitgeschicktes `model`, `apiKey` oder
 * `generationConfig` hat hier keine Wirkung, weil nur die drei bekannten Felder
 * gelesen werden.
 */
export function validateAiRequest(body: unknown): AiRequestValidation {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid_request' };
  }
  const raw = body as Record<string, unknown>;

  if (!isAiOperation(raw.operation)) {
    return { ok: false, error: 'invalid_request' };
  }
  if (typeof raw.workspaceId !== 'string' || !UUID_PATTERN.test(raw.workspaceId)) {
    return { ok: false, error: 'invalid_request' };
  }
  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') {
    return { ok: false, error: 'invalid_request' };
  }
  if (raw.prompt.length > AI_MAX_PROMPT_CHARS[raw.operation]) {
    return { ok: false, error: 'payload_too_large' };
  }

  return {
    ok: true,
    request: {
      operation: raw.operation,
      workspaceId: raw.workspaceId,
      prompt: raw.prompt,
    },
  };
}

/**
 * Profilzustände, die KI nutzen dürfen — abgeleitet aus den tatsächlichen
 * Constraints der `profiles`-Tabelle:
 *   status         in ('pending', 'approved', 'blocked')
 *   license_status in ('inactive', 'active', 'expired')
 *
 * Fail closed: Jeder unbekannte Wert führt zur Ablehnung.
 */
export interface AiProfileState {
  status?: string | null;
  license_status?: string | null;
  license_expires_at?: string | null;
}

export type AiAccessDecision = { allowed: true } | { allowed: false; error: AiErrorCode };

export function evaluateProfileAccess(
  profile: AiProfileState | null | undefined,
  now: Date,
): AiAccessDecision {
  if (!profile) {
    return { allowed: false, error: 'forbidden' };
  }
  if (profile.status !== 'approved') {
    // deckt 'pending', 'blocked' und jeden unbekannten Wert ab
    return { allowed: false, error: 'forbidden' };
  }
  if (profile.license_status !== 'active') {
    // deckt 'inactive', 'expired' und jeden unbekannten Wert ab
    return { allowed: false, error: 'license_inactive' };
  }
  if (profile.license_expires_at) {
    const expires = Date.parse(profile.license_expires_at);
    // Ein unlesbares Datum gilt als abgelaufen, nicht als unbegrenzt.
    if (!Number.isFinite(expires) || expires <= now.getTime()) {
      return { allowed: false, error: 'license_inactive' };
    }
  }
  return { allowed: true };
}

export interface AiRateLimitConfig {
  shortWindowSeconds: number;
  shortWindowLimit: number;
  dailyLimit: number;
}

export type AiRateLimitConfigResult =
  | { ok: true; config: AiRateLimitConfig }
  | { ok: false; error: 'server_misconfigured' };

function readPositiveInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return parsed > 0 ? parsed : null;
}

/**
 * Grenzen kommen aus der Serverumgebung, nicht aus dem Code — wir haben noch
 * keine Nutzungsdaten, und verstreute Zahlen wären später schwer zu finden.
 *
 * **Kein Standardwert**, weder für fehlende noch für ungültige Angaben. Ein
 * Limit, das niemand bewusst gewählt hat, sieht im Betrieb genauso aus wie ein
 * gesetztes: Wird beim Deployment ein Secret vergessen, liefe der Endpunkt
 * scheinbar korrekt mit einer Grenze, die keiner kennt. Bei einem
 * kostenpflichtigen Dienst soll fehlende Konfiguration auffallen, nicht wirken
 * — deshalb `server_misconfigured` statt eines stillen Rückfalls.
 *
 * Die tatsächlichen Werte werden beim Remote-Deployment bewusst gesetzt.
 */
export function resolveRateLimitConfig(
  env: Record<string, string | undefined>,
): AiRateLimitConfigResult {
  const entries: Array<[keyof AiRateLimitConfig, string]> = [
    ['shortWindowSeconds', 'AI_RATE_LIMIT_SHORT_WINDOW_SECONDS'],
    ['shortWindowLimit', 'AI_RATE_LIMIT_SHORT'],
    ['dailyLimit', 'AI_RATE_LIMIT_DAILY'],
  ];

  const config: Partial<AiRateLimitConfig> = {};
  for (const [key, envName] of entries) {
    // Fehlend, leer, nicht ganzzahlig oder <= 0 — alles derselbe Fehler.
    const parsed = readPositiveInt(env[envName]);
    if (parsed === null) {
      return { ok: false, error: 'server_misconfigured' };
    }
    config[key] = parsed;
  }

  return { ok: true, config: config as AiRateLimitConfig };
}

/**
 * Bildet einen Upstream-Fehler auf einen eigenen Code ab.
 *
 * Der Google-Fehlerrumpf wird **nie** durchgereicht: Er kann Kontingent-,
 * Projekt- oder Schlüsselhinweise enthalten, die den Client nichts angehen.
 */
export function mapUpstreamStatus(status: number): AiErrorCode {
  if (status === 408 || status === 504) return 'ai_timeout';
  return 'ai_upstream_error';
}

/** Antwortextraktion — identisch zur bisherigen Client-Logik. */
export function extractGeminiText(data: unknown): string {
  const candidates = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates;
  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => part?.text ?? '')
    .join('\n')
    .trim();
}

/** Gemini-Endpunkt **ohne** Schlüssel im Pfad — der reist im Header. */
export function buildGeminiEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
