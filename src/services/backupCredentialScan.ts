/**
 * EINRICHTUNG-01 (EIN-04; Katalog V3 S-10, S-11) — Zugangsdaten in einer
 * Sicherung **strukturell** erkennen.
 *
 * Bisher suchte die Prüfung Teilzeichenketten wie `sb-`, `Authorization` oder
 * `"password"` im gesamten Zustand — also auch in Geschäftstexten. Eine
 * Mailadresse wie `…@xsb-bau.de`, ein Brief mit „Authorization: Bearer …" oder
 * eine Notiz mit dem Wort „password" machten die Sicherung unbrauchbar, und weil
 * das Sicherheitsbackup vor jeder Wiederherstellung dieselbe Prüfung durchläuft,
 * scheiterte danach jede Wiederherstellung auf dem Gerät.
 *
 * Jetzt zählen nur echte Zugangsstrukturen, in beliebiger Tiefe:
 *   1. Supabase-Sitzungsschlüssel als **Objektschlüssel** (`sb-<projekt>-auth-token`,
 *      `supabase.auth.token`) — so sähe ein eingebetteter Browserspeicher aus.
 *   2. Token-Paare: ein Refresh-Token zusammen mit Access-Token oder Token-Typ;
 *      ein JWT-förmiges Access-Token mit Token-Typ, Ablauf oder Nutzerblock.
 *   3. Ein Feld `Authorization` mit `Bearer <JWT>` als **Schlüssel/Wert-Paar**.
 *   4. Ein Zugangspaar: `password` neben `email` oder `username` im selben Objekt.
 *   5. Token- oder Sitzungsfelder auf der **obersten Ebene** des App-Zustands
 *      (`accessToken`, `refresh_token`, `session` …): Dort stehen nur die bekannten
 *      Bereiche des Bestands, nie Nutzerinhalt — ein solcher Schlüssel ist nie legitim.
 *
 * Ein Feld, das nur so heißt, sperrt in Geschäftsdaten nicht (`password` in einer
 * Notiz, S-11.3). Werte werden nie zurückgegeben — nur die Fundstellen als Pfad (S-11.4).
 */

const SESSION_KEY_PATTERN = /^sb-[a-z0-9-]+-auth-token(?:-code-verifier)?$/i;
const JWT_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const BEARER_JWT_PATTERN = /^Bearer\s+[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\s*$/;

const MAX_DEPTH = 64;
const MAX_FINDINGS = 20;

/** Regel 5 — nur auf der obersten Ebene des App-Zustands. */
const ROOT_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'providerToken',
  'provider_token',
  'providerRefreshToken',
  'provider_refresh_token',
  'idToken',
  'id_token',
  'authToken',
  'auth_token',
  'session',
  'authSession',
  'supabaseSession',
  'currentSession',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return keys.find((key) => nonEmptyString(record[key]));
}

/**
 * Liefert die Pfade erkannter Zugangsstrukturen (`$.a.b[0].refresh_token`),
 * höchstens {@link MAX_FINDINGS}. Leere Liste = keine Zugangsdaten.
 */
export function findBackupCredentialPaths(state: unknown): string[] {
  const findings: string[] = [];

  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || findings.length >= MAX_FINDINGS) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainObject(value)) return;

    for (const key of Object.keys(value)) {
      if (SESSION_KEY_PATTERN.test(key) || key === 'supabase.auth.token') findings.push(`${path}.${key}`);
    }

    const refresh = firstPresent(value, ['refresh_token', 'refreshToken']);
    const access = firstPresent(value, ['access_token', 'accessToken']);
    const tokenType = firstPresent(value, ['token_type', 'tokenType']);
    if (refresh && (access || tokenType)) {
      findings.push(`${path}.${refresh}`);
    } else if (
      access &&
      JWT_PATTERN.test(String(value[access]).trim()) &&
      (tokenType || 'expires_at' in value || 'expires_in' in value || 'user' in value)
    ) {
      findings.push(`${path}.${access}`);
    }

    for (const key of ['Authorization', 'authorization']) {
      if (nonEmptyString(value[key]) && BEARER_JWT_PATTERN.test(value[key] as string)) findings.push(`${path}.${key}`);
    }

    if (nonEmptyString(value.password) && (nonEmptyString(value.email) || nonEmptyString(value.username))) {
      findings.push(`${path}.password`);
    }

    for (const [key, entry] of Object.entries(value)) {
      if (findings.length >= MAX_FINDINGS) return;
      visit(entry, `${path}.${key}`, depth + 1);
    }
  };

  if (isPlainObject(state)) {
    for (const key of Object.keys(state)) {
      const value = state[key];
      const present = nonEmptyString(value) || isPlainObject(value);
      if (ROOT_CREDENTIAL_KEYS.has(key) && present) findings.push(`$.${key}`);
    }
  }

  visit(state, '$', 0);
  return [...new Set(findings)].slice(0, MAX_FINDINGS);
}
