/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.25, K2) — Kontolöschung als dauerhafter Auftrag, Entscheidungen ohne Deno-APIs.
 *
 *   Schritt 1 (SQL, eine Transaktion, Token der Person): `account_deletion_begin` — Voraussetzungen unter Sperre,
 *            Nachweis verbraucht, Mitgliedschaften beendet, Profil pseudonymisiert und gesperrt. Ergebnis `sql_done`.
 *   Schritt 2 (Dienstrolle, je Teilschritt idempotent): Auth-E-Mail auf das Pseudonym, Zufallspasswort, Sperre,
 *            Metadaten leer (Admin-API) → vermerkt; Sitzungen und Refresh-Tokens → vermerkt; Identitäten → vermerkt.
 *            Ergebnis `auth_done`.
 *   Schritt 3: Abschluss `completed`, Prüfspur `account_deleted` genau einmal.
 *
 * Scheitert ein Teilschritt von 2 oder 3, bleibt der Auftrag im erreichten Zustand mit Fehlercode (ohne Geheimnisse)
 * und wird fortgesetzt — über denselben Aufruf mit derselben Anfrage-ID oder den Dienstweg `account-deletion-resume`.
 * Die Antwort lautet dann „Löschung begonnen, wird abgeschlossen“, nie „vollständig gelöscht“.
 */
export interface AccountDeletionJob {
  jobId: string;
  userId: string;
  requestId: string;
  state: 'requested' | 'sql_done' | 'auth_done' | 'completed';
  pseudonymEmail: string;
  authEmailDone: boolean;
  authSessionsDone: boolean;
  authIdentitiesDone: boolean;
  lastErrorCode: string | null;
}

export interface AccountDeletionAuthDeps {
  loadJob(jobId: string): Promise<AccountDeletionJob | null>;
  /** Admin-API: E-Mail = Pseudonym (bestätigt), Zufallspasswort, Sperre bis auf Weiteres, Metadaten leer. */
  pseudonymizeAuthUser(userId: string, pseudonymEmail: string): Promise<{ ok: boolean; code?: string }>;
  step(jobId: string, step: 'email' | 'sessions' | 'identities' | 'error', errorCode?: string): Promise<AccountDeletionJob | null>;
  complete(jobId: string): Promise<AccountDeletionJob | null>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export type AccountDeletionProgress =
  | { state: 'completed' }
  | { state: 'sql_done' | 'auth_done'; completing: true; errorCode: string };

/** Setzt einen Auftrag ab dem erreichten Zustand fort; jeder vermerkte Teilschritt wirkt kein zweites Mal. */
export async function runAccountDeletionAuthSteps(jobId: string, deps: AccountDeletionAuthDeps): Promise<AccountDeletionProgress> {
  let job = await deps.loadJob(jobId);
  if (!job) return { state: 'sql_done', completing: true, errorCode: 'job_not_found' };
  if (job.state === 'completed') return { state: 'completed' };

  const scheitern = async (code: string): Promise<AccountDeletionProgress> => {
    const stand = await deps.step(jobId, 'error', code);
    deps.log({ outcome: 'auth_step_failed', code });
    return { state: stand?.state === 'auth_done' ? 'auth_done' : 'sql_done', completing: true, errorCode: code };
  };

  if (job.state === 'sql_done') {
    if (!job.authEmailDone) {
      const result = await deps.pseudonymizeAuthUser(job.userId, job.pseudonymEmail);
      if (!result.ok) return scheitern(result.code ?? 'auth_email_failed');
      job = (await deps.step(jobId, 'email')) ?? job;
    }
    if (!job.authSessionsDone) {
      const next = await deps.step(jobId, 'sessions');
      if (!next?.authSessionsDone) return scheitern('auth_sessions_failed');
      job = next;
    }
    if (!job.authIdentitiesDone) {
      const next = await deps.step(jobId, 'identities');
      if (!next?.authIdentitiesDone) return scheitern('auth_identities_failed');
      job = next;
    }
  }
  if (job.state !== 'auth_done' && job.state !== 'completed') return scheitern('auth_state_incomplete');
  const fertig = await deps.complete(jobId);
  if (fertig?.state !== 'completed') return scheitern('complete_failed');
  deps.log({ outcome: 'completed' });
  return { state: 'completed' };
}

export type DeleteAccountOutcome =
  | { ok: true; state: 'completed' }
  | { ok: true; state: 'sql_done' | 'auth_done'; completing: true }
  | {
      ok: false;
      error:
        | 'invalid_request'
        | 'unauthenticated'
        | 'session_not_active'
        | 'account_blocked'
        | 'confirmation_invalid'
        | 'account_owner'
        | 'last_platform_admin'
        | 'email_mismatch'
        | 'deletion_request_mismatch'
        | 'server_error';
      workspaces?: Array<{ workspace_id: string; name: string }>;
      ways?: string[];
    };

export type BeginResult =
  | { ok: true; jobId: string; state: AccountDeletionJob['state'] }
  | { ok: false; code: string; workspaces?: Array<{ workspace_id: string; name: string }>; ways?: string[] };

export interface DeleteAccountDeps extends AccountDeletionAuthDeps {
  /** `account_deletion_begin` mit dem Token der Person (Sitzung, Identität und Sperren prüft der Server). */
  begin(input: { requestId: string; confirmationToken: string | null; email: string | null }): Promise<BeginResult>;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BEGIN_CODES = new Set([
  'unauthenticated',
  'session_not_active',
  'account_blocked',
  'confirmation_invalid',
  'account_owner',
  'last_platform_admin',
  'email_mismatch',
  'deletion_request_mismatch',
]);

export async function runDeleteAccount(
  input: { userId: string | null; requestId: unknown; confirmationToken: unknown; email: unknown },
  deps: DeleteAccountDeps,
): Promise<DeleteAccountOutcome> {
  if (!input.userId) return { ok: false, error: 'unauthenticated' };
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  if (!UUID.test(requestId)) return { ok: false, error: 'invalid_request' };
  const confirmationToken = typeof input.confirmationToken === 'string' ? input.confirmationToken : null;
  const email = typeof input.email === 'string' ? input.email : null;

  const begun = await deps.begin({ requestId, confirmationToken, email });
  if (!begun.ok) {
    deps.log({ outcome: begun.code });
    const error = (BEGIN_CODES.has(begun.code) ? begun.code : 'server_error') as Extract<DeleteAccountOutcome, { ok: false }>['error'];
    return { ok: false, error, ...(begun.workspaces ? { workspaces: begun.workspaces } : {}), ...(begun.ways ? { ways: begun.ways } : {}) };
  }
  if (begun.state === 'completed') return { ok: true, state: 'completed' };
  const progress = await runAccountDeletionAuthSteps(begun.jobId, deps);
  return progress.state === 'completed' ? { ok: true, state: 'completed' } : { ok: true, state: progress.state, completing: true };
}

/** Fehlertext des Servers → Code; nie der Rohtext in der Antwort. */
export function beginErrorCode(message: string | null | undefined): string {
  const text = message ?? '';
  for (const code of ['confirmation_invalid', 'session_not_active', 'account_blocked', 'request_id_missing']) {
    if (text.includes(code)) return code === 'request_id_missing' ? 'invalid_request' : code;
  }
  if (/Nicht angemeldet|profile_missing/.test(text)) return 'unauthenticated';
  return 'server_error';
}

/** Dienstweg: alle offenen Aufträge fortsetzen; Zusammenfassung ohne personenbezogene Angaben. */
export async function runAccountDeletionResume(
  deps: AccountDeletionAuthDeps & { pendingJobIds(limit: number): Promise<string[]> },
): Promise<{ jobs: number; completed: number; pending: number }> {
  const ids = await deps.pendingJobIds(50);
  let completed = 0;
  for (const id of ids) {
    const progress = await runAccountDeletionAuthSteps(id, deps);
    if (progress.state === 'completed') completed += 1;
  }
  return { jobs: ids.length, completed, pending: ids.length - completed };
}

export function toAccountDeletionJob(row: Record<string, unknown> | null | undefined): AccountDeletionJob | null {
  if (!row || typeof row.job_id !== 'string') return null;
  const state = row.state;
  if (state !== 'requested' && state !== 'sql_done' && state !== 'auth_done' && state !== 'completed') return null;
  return {
    jobId: row.job_id,
    userId: typeof row.user_id === 'string' ? row.user_id : '',
    requestId: typeof row.request_id === 'string' ? row.request_id : '',
    state,
    pseudonymEmail: typeof row.pseudonym_email === 'string' ? row.pseudonym_email : '',
    authEmailDone: row.auth_email_done === true,
    authSessionsDone: row.auth_sessions_done === true,
    authIdentitiesDone: row.auth_identities_done === true,
    lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
  };
}
