/**
 * SECURITY-GEMINI-KEY-01B — der Weg zum OfficePilot-KI-Endpunkt.
 *
 * Ersetzt den bisherigen direkten Gemini-Aufruf aus dem Browser. Was hier
 * **nicht** mehr vorkommt: ein API-Schlüssel, ein Modellname, eine
 * Generationskonfiguration, eine Google-Adresse. Der Client schickt nur, was
 * die Operation ausmacht — alles Übrige entscheidet der Server.
 *
 * Es gibt bewusst **keinen** Rückfall auf den alten Direktaufruf. Ist der
 * Endpunkt nicht erreichbar, gilt KI als vorübergehend nicht verfügbar; die
 * regelbasierten Wege der Anwendung laufen weiter. Ein Rückfall würde den
 * Schlüssel wieder in den Browser holen und damit genau das Problem
 * zurückbringen, das dieser Block löst.
 */
import { getSupabaseClient, getSupabaseUrl, isSupabaseConfigured } from '../../lib/supabase';
import { getSyncClient } from '../sync/syncClientService';
import type { AiOperation, GenerateTextResult } from '../../types/ai';

type FetchOverride = typeof fetch;

let fetchOverride: FetchOverride | null = null;

/** Testnaht — dieselbe wie zuvor, damit bestehende Tests weiter greifen. */
export function setAiProxyFetchForTests(fetchFn: FetchOverride | null): void {
  fetchOverride = fetchFn;
}

/**
 * Nutzertexte je Fehlercode des Endpunkts. Der Server liefert nur den Code;
 * die Formulierung gehört in den Client — und ein Google-Fehlerrumpf erreicht
 * ihn ohnehin nie.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_request: 'Die Anfrage war unvollständig.',
  unauthenticated: 'Bitte melden Sie sich erneut an.',
  forbidden: 'Ihr Zugang ist derzeit nicht freigeschaltet.',
  license_inactive: 'Für diesen Zugang ist keine aktive Lizenz hinterlegt.',
  workspace_forbidden: 'Kein Zugriff auf diesen Betrieb.',
  rate_limited: 'Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.',
  payload_too_large: 'Der Inhalt ist zu umfangreich für eine Anfrage.',
  ai_timeout: 'Die Antwort hat zu lange gedauert. Bitte erneut versuchen.',
  ai_upstream_error: 'Der KI-Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen.',
  ai_empty_response: 'Es wurde keine Antwort erhalten. Bitte versuchen Sie es erneut.',
  server_misconfigured: 'Die KI-Verbindung ist nicht eingerichtet.',
};

/** Fehlercodes des Servers auf die im Client bekannten Codes abbilden. */
function toProviderErrorCode(serverError: string): GenerateTextResult extends never
  ? never
  : Extract<GenerateTextResult, { success: false }>['errorCode'] {
  switch (serverError) {
    case 'unauthenticated':
    case 'forbidden':
    case 'license_inactive':
    case 'workspace_forbidden':
    case 'rate_limited':
    case 'payload_too_large':
    case 'ai_timeout':
    case 'server_misconfigured':
      return serverError;
    case 'invalid_request':
      return 'invalid_prompt';
    case 'ai_empty_response':
      return 'empty_response';
    default:
      return 'api_error';
  }
}

function failure(code: string): GenerateTextResult {
  return {
    success: false,
    errorCode: toProviderErrorCode(code),
    message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.ai_upstream_error,
  };
}

/**
 * Der Workspace wird an der zentralen Stelle geholt, nicht durch fünf
 * Fachketten gereicht: `syncClientService` ist bereits die einzige Quelle der
 * Workspace-Kennung im Client. Der Server prüft sie ohnehin gegen die
 * Mitgliedschaft — eine gefälschte Kennung nützt nichts.
 */
function resolveWorkspaceId(): string | undefined {
  const client = getSyncClient();
  return client.serverWorkspaceId ?? undefined;
}

export async function callAiProxy(
  operation: AiOperation,
  prompt: string,
): Promise<GenerateTextResult> {
  if (!isSupabaseConfigured()) {
    return failure('server_misconfigured');
  }

  const workspaceId = resolveWorkspaceId();
  if (!workspaceId) {
    return failure('workspace_forbidden');
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return failure('server_misconfigured');
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) {
    return failure('unauthenticated');
  }

  const baseUrl = getSupabaseUrl();
  if (!baseUrl) {
    return failure('server_misconfigured');
  }

  const fetchFn = fetchOverride ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/functions/v1/ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      // Genau drei Felder. Kein Modell, kein Schlüssel, keine Konfiguration.
      body: JSON.stringify({ operation, workspaceId, prompt }),
    });
  } catch {
    return failure('ai_upstream_error');
  }

  let payload: { ok?: boolean; text?: string; error?: string };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return failure('ai_upstream_error');
  }

  if (!response.ok || payload.ok !== true) {
    return failure(typeof payload.error === 'string' ? payload.error : 'ai_upstream_error');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return failure('ai_empty_response');
  }

  return { success: true, text };
}
