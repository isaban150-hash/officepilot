/**
 * SECURITY-GEMINI-KEY-01B — der KI-Endpunkt.
 *
 * Bis hierher lief der Gemini-Aufruf im Browser, mit dem Schlüssel als
 * `VITE_`-Variable im Bundle und zusätzlich als `?key=` in der Adresse. Jeder
 * Nutzer konnte ihn auslesen und auf fremde Rechnung verwenden.
 *
 * Diese Funktion ist die Grenze: Der Schlüssel existiert nur noch hier, und
 * davor stehen fünf Prüfungen — Sitzung, Kontostatus, Lizenz, Mitgliedschaft
 * im angegebenen Workspace, Nutzungshäufigkeit. Erst danach wird Gemini
 * überhaupt angesprochen.
 *
 * Was hier bewusst **nicht** stattfindet: Fachlogik. Prompts werden weiterhin
 * im Client gebaut, Antworten dort geprüft (`aiOutputGuardService`,
 * `validateFactAssignments`, Parser). Diese Funktion ist Transport- und
 * Sicherheitsgrenze, kein zweiter Ort für Produktwissen.
 *
 * DOKUMENT-ASSISTENT-01H2B ergänzt genau eine Ausnahme, und sie bestätigt die
 * Regel: die Prüfung auf verbindliche Rechts- und Steuerentscheidungen. Sie
 * gehört hierher, weil sie eine **Sicherheitsgrenze** ist und keine
 * Produktentscheidung — eine Schranke, die man durch Weglassen des Clients
 * umgeht, ist keine. Die Regel selbst wird nicht hier geschrieben, sondern
 * aus `_shared/legalClaimCore.ts` geholt, damit Browser und Server dieselbe
 * verwenden. Die Clientprüfung bleibt zusätzlich bestehen.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  AI_HTTP_STATUS,
  AI_MAX_REQUEST_BYTES,
  AI_MODEL_BY_OPERATION,
  AI_UPSTREAM_TIMEOUT_MS,
  buildGeminiEndpoint,
  evaluateWorkspaceAccessDenial,
  extractGeminiText,
  mapUpstreamStatus,
  resolveRateLimitConfig,
  validateAiRequest,
  type AiErrorCode,
} from '../_shared/aiContract.ts';
import {
  guardAiAnswerText,
  isServerClaimGuardedOperation,
} from '../_shared/legalClaimCore.ts';

/*
 * `apikey` und `x-client-info` gehören dazu, auch wenn der heutige Aufruf sie
 * nicht selbst setzt: Das Supabase-Gateway erwartet `apikey`, und
 * `supabase.functions.invoke()` fügt beide von sich aus hinzu. Fehlen sie in
 * der Freigabe, scheitert der Preflight später mit einer CORS-Meldung, die auf
 * die Funktion zeigt statt auf den Header.
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function fail(error: AiErrorCode): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: AI_HTTP_STATUS[error],
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function ok(text: string): Response {
  return new Response(JSON.stringify({ ok: true, text }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Nur technische Kennzahlen. Niemals Prompt, Dokumenttext, Antwort, Namen,
 * Beträge, Kopfzeilen oder der Schlüssel — die Funktionsprotokolle sind in der
 * Supabase-Oberfläche einsehbar.
 */
function logUsage(entry: Record<string, string | number>): void {
  console.log(JSON.stringify({ scope: 'ai', ...entry }));
}

Deno.serve(async (request: Request): Promise<Response> => {
  const startedAt = Date.now();

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return fail('invalid_request');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return fail('server_misconfigured');
  }

  const rateConfig = resolveRateLimitConfig({
    AI_RATE_LIMIT_SHORT_WINDOW_SECONDS: Deno.env.get('AI_RATE_LIMIT_SHORT_WINDOW_SECONDS'),
    AI_RATE_LIMIT_SHORT: Deno.env.get('AI_RATE_LIMIT_SHORT'),
    AI_RATE_LIMIT_DAILY: Deno.env.get('AI_RATE_LIMIT_DAILY'),
  });
  if (!rateConfig.ok) {
    return fail('server_misconfigured');
  }

  /*
   * Die Grösse wird vor dem Parsen geprüft. Ein Client soll keinen beliebig
   * grossen Rumpf durch die Funktion schieben können.
   */
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > AI_MAX_REQUEST_BYTES) {
    return fail('payload_too_large');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return fail('invalid_request');
  }

  const validation = validateAiRequest(parsedBody);
  if (!validation.ok) {
    return fail(validation.error);
  }
  const { operation, workspaceId, prompt } = validation.request;

  /*
   * Die Benutzerkennung stammt ausschliesslich aus dem Token — niemals aus dem
   * Rumpf. Der Vertrag kennt kein `userId`-Feld.
   */
  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return fail('unauthenticated');
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(
    authorization.slice('bearer '.length).trim(),
  );
  const userId = userData?.user?.id;
  if (userError || !userId) {
    return fail('unauthenticated');
  }

  /*
   * EINRICHTUNG-01 (AP1, E3) — die zentrale Zugriffsregel des Servers in einem Aufruf: Sperre, Freigabe, aktive
   * Mitgliedschaft im **angegebenen** Workspace und die Betriebslizenz — die Lizenz des Inhabers, nicht die eigene.
   * Eine fremde Kennung im Rumpf funktioniert nicht. Für das Verstehen von Dokumenten genügt aktive Mitgliedschaft
   * jeder Rolle; Schreibrechte zu verlangen wäre hier zu streng.
   *
   * Der Fehler der Abfrage wird ausgewertet, nicht verworfen: Ein Datenbank- oder Berechtigungsfehler ist keine
   * Sperre (Realtest SECURITY-GEMINI-KEY-01B-R3). Fail closed, aber mit dem technischen Code.
   */
  const { data: denial, error: accessError } = await admin.rpc('workspace_user_access_denial', {
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_action: 'member',
  });

  if (accessError) {
    // Keine Supabase-Meldung und keine SQL-Details nach aussen.
    logUsage({ operation, userId, outcome: 'access_check_failed' });
    return fail('server_misconfigured');
  }

  const access = evaluateWorkspaceAccessDenial(denial);
  if (!access.allowed) {
    logUsage({ operation, userId, outcome: access.error });
    return fail(access.error);
  }

  /*
   * EINRICHTUNG-01 (Z-02.2, Z-04.8) — der Schlüssel wird erst nach Anmeldung und Zugriffsregel geprüft: Wer nicht
   * angemeldet ist oder abgewiesen wird, erfährt nichts über die Konfiguration. Vor der Zählung, damit ein Aufruf,
   * der nicht ausgeführt werden kann, das Limit nicht verbraucht.
   */
  if (!geminiApiKey) {
    logUsage({ operation, userId, outcome: 'not_configured' });
    return fail('server_misconfigured');
  }

  /*
   * Zählung und Prüfung in **einem** atomaren Datenbankaufruf. Ein
   * Lesen-dann-Schreiben liesse zwei gleichzeitige Anfragen dasselbe Limit
   * passieren.
   */
  const { data: rateResult, error: rateError } = await admin.rpc('ai_usage_check_and_count', {
    p_user_id: userId,
    p_workspace_id: workspaceId,
    p_operation: operation,
    p_short_window_seconds: rateConfig.config.shortWindowSeconds,
    p_short_limit: rateConfig.config.shortWindowLimit,
    p_daily_limit: rateConfig.config.dailyLimit,
  });

  if (rateError) {
    // Fail closed: Ohne funktionierende Zählung wird nichts durchgelassen.
    logUsage({ operation, userId, outcome: 'rate_check_failed' });
    return fail('server_misconfigured');
  }
  if (rateResult !== true) {
    logUsage({ operation, userId, workspaceId, outcome: 'rate_limited' });
    return fail('rate_limited');
  }

  const model = AI_MODEL_BY_OPERATION[operation];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_UPSTREAM_TIMEOUT_MS);

  try {
    // Der Schlüssel reist im Header, nicht in der Adresse.
    const upstream = await fetch(buildGeminiEndpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey,
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // Kein Weiterreichen des Google-Fehlerrumpfs.
      logUsage({
        operation,
        userId,
        workspaceId,
        model,
        upstreamStatus: upstream.status,
        durationMs: Date.now() - startedAt,
        outcome: 'upstream_error',
      });
      return fail(mapUpstreamStatus(upstream.status));
    }

    const data = await upstream.json();
    const text = extractGeminiText(data);
    if (!text) {
      return fail('ai_empty_response');
    }

    /*
     * DOKUMENT-ASSISTENT-01H2B — die fachliche Grenze, serverseitig.
     *
     * Der kleinste mögliche Punkt: hier ist die Antwort vollständig und noch
     * nicht herausgegeben. Alles davor — Sitzung, Lizenz, Mitgliedschaft,
     * Zählung — bleibt unberührt; danach gibt es nichts mehr zu prüfen.
     *
     * Bis hierher galt der Satz im Kopf dieser Datei uneingeschränkt: keine
     * Fachlogik auf dem Server. Er gilt weiter für Prompts, Parser und
     * Produktwissen. Eine *Sicherheitsgrenze* ist aber keine Fachlogik: Was
     * der Client prüft, kann umgangen werden, indem man den Client weglässt.
     * Für eine Zusage über Recht oder Steuern darf das nicht gelten.
     *
     * Geprüft werden nur die Ketten, die dem Benutzer Fliesstext auf eine
     * Frage liefern. Die strukturierte Feldzuordnung und der Briefentwurf
     * bleiben unangetastet — ihnen dieselbe Behandlung zu geben, hiesse
     * verschiedene Dinge gleich zu behandeln.
     */
    let antwort = text;
    if (isServerClaimGuardedOperation(operation)) {
      const geprueft = guardAiAnswerText(text);
      antwort = geprueft.text;
      if (geprueft.removed > 0) {
        /*
         * Der Grund gehört ins Protokoll, nicht in die Antwort. Nach aussen
         * geht Fachsprache, nie Prüfsprache — und niemals der beanstandete
         * Satz selbst, der hier im Klartext stünde.
         */
        logUsage({
          operation,
          userId,
          workspaceId,
          removedClaims: geprueft.removed,
          outcome: geprueft.replaced ? 'claim_guard_replaced' : 'claim_guard_pruned',
        });
      }
    }

    logUsage({
      operation,
      userId,
      workspaceId,
      model,
      promptChars: prompt.length,
      durationMs: Date.now() - startedAt,
      outcome: 'ok',
    });
    return ok(antwort);
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    logUsage({
      operation,
      userId,
      durationMs: Date.now() - startedAt,
      outcome: aborted ? 'timeout' : 'upstream_exception',
    });
    // Kein Wiederholungsversuch: Ein Retry kostet erneut Geld.
    return fail(aborted ? 'ai_timeout' : 'ai_upstream_error');
  } finally {
    clearTimeout(timeout);
  }
});
