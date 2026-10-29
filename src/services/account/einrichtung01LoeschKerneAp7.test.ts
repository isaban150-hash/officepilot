/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.25a, 1.26; K1–K3) — Entscheidungen der Edge Functions ohne Deno-APIs.
 *
 *   L-01.5/L-01.10/L-01.11  Nachweis: Passwort serverseitig geprüft, nie protokolliert; Prüfsitzung widerrufen; nur der
 *                           Hash geht an den Server; Versuchslimit
 *   L-01.4–L-01.4d          Kontolöschung als Auftrag: Teilschritte je einmal, Fortsetzung, „wird abgeschlossen“
 *   L-05.5/L-05.6/L-05.10   Betriebslöschung: fremde Sperre, Storage-Fehler mitten in der Liste, nur eigene Objekte
 *   Dienstwege              nur Planer-Geheimnis bzw. Dienstrollen-Schlüssel
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONFIRMATION_TOKEN_PATTERN,
  precheckErrorCode,
  runDestructiveConfirm,
  type DestructiveConfirmDeps,
} from '../../../supabase/functions/_shared/destructiveConfirmCore';
import {
  beginErrorCode,
  runAccountDeletionAuthSteps,
  runAccountDeletionResume,
  runDeleteAccount,
  toAccountDeletionJob,
  type AccountDeletionJob,
  type DeleteAccountDeps,
} from '../../../supabase/functions/_shared/accountDeletionCore';
import {
  isOwnDeletionObject,
  runWorkspaceDeletion,
  runWorkspaceDeletionBatch,
  type WorkspaceDeletionRunDeps,
} from '../../../supabase/functions/_shared/workspaceDeletionRunCore';
import { constantTimeEqual, isSchedulerOrServiceCall } from '../../../supabase/functions/_shared/schedulerAuth';

const REQ = '11111111-2222-4333-8444-555555555555';
const WS = '00000000-0000-4000-8000-0000000007a1';
const PASSWORT = 'Sehr-Geheim-Passwort-42';
const TOKEN = 'A'.repeat(43);

function confirmDeps(overrides: Partial<DestructiveConfirmDeps> = {}): DestructiveConfirmDeps & { logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    precheck: async () => ({ ok: true, userId: 'u1', email: 'person@example.invalid' }),
    signInWithPassword: async () => ({ ok: true, accessToken: 'pruefsitzung' }),
    revokeSession: async () => true,
    recordFailure: vi.fn(async () => undefined),
    randomToken: () => TOKEN,
    sha256Hex: async (value) => `hash(${value.length})`,
    issue: vi.fn(async () => ({ ok: true, expiresAt: '2026-10-25T10:05:00.000Z' })),
    log: (entry) => logs.push(entry),
    ...overrides,
  };
}

describe('EINRICHTUNG-01 AP7 — Bestätigungsnachweis (1.25a)', () => {
  it('prüft die Eingabe: Aktion, Anfrage-ID, Zielbindung, Passwortlänge', async () => {
    const d = confirmDeps();
    const faelle = [
      { action: 'irgendwas', workspaceId: null, requestId: REQ, password: PASSWORT },
      { action: 'account_delete', workspaceId: null, requestId: 'keine-uuid', password: PASSWORT },
      { action: 'account_delete', workspaceId: WS, requestId: REQ, password: PASSWORT },
      { action: 'workspace_delete_request', workspaceId: null, requestId: REQ, password: PASSWORT },
      { action: 'workspace_delete_request', workspaceId: 'kein-ws', requestId: REQ, password: PASSWORT },
      { action: 'account_delete', workspaceId: null, requestId: REQ, password: '' },
      { action: 'account_delete', workspaceId: null, requestId: REQ, password: 'x'.repeat(257) },
    ];
    for (const fall of faelle) {
      expect(await runDestructiveConfirm(fall, d), JSON.stringify(fall).slice(0, 80)).toEqual({ ok: false, error: 'invalid_request' });
    }
  });

  it('L-01.5/L-01.10: falsches Passwort → Fehlversuch vermerkt; Passwort nie im Protokoll; kein Nachweis', async () => {
    const d = confirmDeps({ signInWithPassword: async () => ({ ok: false, reason: 'invalid_credentials' }) });
    const result = await runDestructiveConfirm({ action: 'account_delete', workspaceId: null, requestId: REQ, password: PASSWORT }, d);
    expect(result).toEqual({ ok: false, error: 'password_invalid' });
    expect(d.recordFailure).toHaveBeenCalledWith('u1');
    expect(d.issue).not.toHaveBeenCalled();
    expect(JSON.stringify(d.logs)).not.toContain(PASSWORT);
  });

  it('L-01.11: Versuchslimit der Vorprüfung bzw. von Supabase Auth → confirmation_rate_limited', async () => {
    const vor = confirmDeps({ precheck: async () => ({ ok: false, code: 'confirmation_rate_limited' }) });
    const signIn = vi.fn();
    vor.signInWithPassword = signIn;
    expect(await runDestructiveConfirm({ action: 'account_delete', workspaceId: null, requestId: REQ, password: PASSWORT }, vor)).toEqual({ ok: false, error: 'confirmation_rate_limited' });
    expect(signIn).not.toHaveBeenCalled();
    const auth = confirmDeps({ signInWithPassword: async () => ({ ok: false, reason: 'rate_limited' }) });
    expect(await runDestructiveConfirm({ action: 'account_delete', workspaceId: null, requestId: REQ, password: PASSWORT }, auth)).toEqual({ ok: false, error: 'confirmation_rate_limited' });
  });

  it('L-01.10: ohne Widerruf der Prüfsitzung kein Nachweis; nur der Hash geht an den Server; Token nur in der Antwort', async () => {
    const ohneWiderruf = confirmDeps({ revokeSession: async () => false });
    expect(await runDestructiveConfirm({ action: 'account_delete', workspaceId: null, requestId: REQ, password: PASSWORT }, ohneWiderruf)).toEqual({ ok: false, error: 'server_error' });
    expect(ohneWiderruf.issue).not.toHaveBeenCalled();

    const d = confirmDeps();
    const result = await runDestructiveConfirm({ action: 'workspace_delete_request', workspaceId: WS, requestId: REQ, password: PASSWORT }, d);
    expect(result).toEqual({ ok: true, confirmationToken: TOKEN, expiresAt: '2026-10-25T10:05:00.000Z' });
    expect(d.issue).toHaveBeenCalledWith({ userId: 'u1', action: 'workspace_delete_request', workspaceId: WS, requestId: REQ, tokenHash: 'hash(43)' });
    expect(JSON.stringify(d.logs)).not.toContain(TOKEN);
    expect(JSON.stringify(d.logs)).not.toContain(PASSWORT);
    expect(CONFIRMATION_TOKEN_PATTERN.test(TOKEN)).toBe(true);
  });

  it('ein ungültiges Zufallstoken bzw. eine gesperrte Ausstellung liefert keinen Nachweis', async () => {
    expect(await runDestructiveConfirm({ action: 'account_delete', workspaceId: null, requestId: REQ, password: PASSWORT }, confirmDeps({ randomToken: () => 'kurz' }))).toEqual({ ok: false, error: 'server_error' });
    expect(await runDestructiveConfirm({ action: 'account_delete', workspaceId: null, requestId: REQ, password: PASSWORT }, confirmDeps({ issue: async () => ({ ok: false, code: 'account_blocked' }) }))).toEqual({ ok: false, error: 'account_blocked' });
  });

  it('Fehlertexte der Vorprüfung werden Codes, nie Rohtext', () => {
    expect(precheckErrorCode('session_not_active: x')).toBe('session_not_active');
    expect(precheckErrorCode('account_blocked: Konto')).toBe('account_blocked');
    expect(precheckErrorCode('Nicht angemeldet')).toBe('unauthenticated');
    expect(precheckErrorCode('JWT expired')).toBe('unauthenticated');
    expect(precheckErrorCode('irgendein interner Fehler mit Details')).toBe('server_error');
    expect(precheckErrorCode(null)).toBe('server_error');
  });
});

function job(extra: Partial<AccountDeletionJob> = {}): AccountDeletionJob {
  return { jobId: 'j1', userId: 'u1', requestId: REQ, state: 'sql_done', pseudonymEmail: 'geloescht-u1@invalid.officetakt', authEmailDone: false, authSessionsDone: false, authIdentitiesDone: false, lastErrorCode: null, ...extra };
}

function deletionDeps(start: AccountDeletionJob, overrides: Partial<DeleteAccountDeps> = {}): DeleteAccountDeps & { stand: AccountDeletionJob; pseudo: ReturnType<typeof vi.fn> } {
  const stand = { ...start };
  const pseudo = vi.fn(async () => ({ ok: true }));
  return {
    stand,
    pseudo,
    begin: async () => ({ ok: true, jobId: stand.jobId, state: stand.state }),
    loadJob: async () => ({ ...stand }),
    pseudonymizeAuthUser: pseudo,
    step: async (_id, step, code) => {
      if (step === 'email') stand.authEmailDone = true;
      if (step === 'sessions') stand.authSessionsDone = true;
      if (step === 'identities') {
        stand.authIdentitiesDone = true;
        stand.state = 'auth_done';
      }
      if (step === 'error') stand.lastErrorCode = code ?? null;
      return { ...stand };
    },
    complete: async () => {
      stand.state = 'completed';
      return { ...stand };
    },
    log: () => undefined,
    ...overrides,
  };
}

describe('EINRICHTUNG-01 AP7 — Kontolöschung als Auftrag (1.25, K2)', () => {
  it('Eingaben und Abweisungen des SQL-Teils: Codes ohne Rohtext, Inhaberliste mit Wegen', async () => {
    const d = deletionDeps(job());
    expect(await runDeleteAccount({ userId: null, requestId: REQ, confirmationToken: TOKEN, email: 'x' }, d)).toEqual({ ok: false, error: 'unauthenticated' });
    expect(await runDeleteAccount({ userId: 'u1', requestId: 'x', confirmationToken: TOKEN, email: 'x' }, d)).toEqual({ ok: false, error: 'invalid_request' });
    const inhaber = deletionDeps(job(), {
      begin: async () => ({ ok: false, code: 'account_owner', workspaces: [{ workspace_id: WS, name: 'W1' }], ways: ['ownership_transfer', 'workspace_delete'] }),
    });
    expect(await runDeleteAccount({ userId: 'u1', requestId: REQ, confirmationToken: TOKEN, email: 'x' }, inhaber)).toEqual({
      ok: false, error: 'account_owner', workspaces: [{ workspace_id: WS, name: 'W1' }], ways: ['ownership_transfer', 'workspace_delete'],
    });
    const unbekannt = deletionDeps(job(), { begin: async () => ({ ok: false, code: 'interner_fehler_mit_details' }) });
    expect(await runDeleteAccount({ userId: 'u1', requestId: REQ, confirmationToken: TOKEN, email: 'x' }, unbekannt)).toEqual({ ok: false, error: 'server_error' });
    expect(beginErrorCode('confirmation_invalid: Nachweis')).toBe('confirmation_invalid');
    expect(beginErrorCode('request_id_missing')).toBe('invalid_request');
    expect(beginErrorCode('Nicht angemeldet')).toBe('unauthenticated');
    expect(beginErrorCode('x')).toBe('server_error');
  });

  it('L-01.1: alle Teilschritte, dann completed', async () => {
    const d = deletionDeps(job());
    expect(await runDeleteAccount({ userId: 'u1', requestId: REQ, confirmationToken: TOKEN, email: 'x' }, d)).toEqual({ ok: true, state: 'completed' });
    expect(d.pseudo).toHaveBeenCalledWith('u1', 'geloescht-u1@invalid.officetakt');
    expect(d.stand).toMatchObject({ authEmailDone: true, authSessionsDone: true, authIdentitiesDone: true, state: 'completed' });
  });

  it('L-01.4b: Auth-E-Mail scheitert → sql_done mit Fehlercode, Antwort „wird abgeschlossen“', async () => {
    const d = deletionDeps(job(), { pseudonymizeAuthUser: async () => ({ ok: false, code: 'auth_email_failed' }) });
    expect(await runDeleteAccount({ userId: 'u1', requestId: REQ, confirmationToken: TOKEN, email: 'x' }, d)).toEqual({ ok: true, state: 'sql_done', completing: true });
    expect(d.stand.lastErrorCode).toBe('auth_email_failed');
    expect(d.stand.state).toBe('sql_done');
  });

  it('L-01.4c/L-01.4d: Fortsetzung — vermerkte Teilschritte wirken kein zweites Mal', async () => {
    const d = deletionDeps(job({ authEmailDone: true, authSessionsDone: true }));
    const progress = await runAccountDeletionAuthSteps('j1', d);
    expect(progress).toEqual({ state: 'completed' });
    expect(d.pseudo).not.toHaveBeenCalled();
    const fertig = deletionDeps(job({ state: 'completed' }));
    expect(await runAccountDeletionAuthSteps('j1', fertig)).toEqual({ state: 'completed' });
    expect(fertig.pseudo).not.toHaveBeenCalled();
  });

  it('Dienstweg account-deletion-resume: offene Aufträge, Zusammenfassung ohne Personenbezug', async () => {
    const d = deletionDeps(job());
    const result = await runAccountDeletionResume({ ...d, pendingJobIds: async () => ['j1'] });
    expect(result).toEqual({ jobs: 1, completed: 1, pending: 0 });
    expect(JSON.stringify(result)).not.toContain('u1');
  });

  it('Auftragszeilen werden streng gelesen', () => {
    expect(toAccountDeletionJob(null)).toBeNull();
    expect(toAccountDeletionJob({ job_id: 'j', state: 'unbekannt' })).toBeNull();
    expect(toAccountDeletionJob({ job_id: 'j', user_id: 'u', request_id: REQ, state: 'auth_done', pseudonym_email: 'p', auth_email_done: true, auth_sessions_done: 'ja', auth_identities_done: true, last_error_code: 7 })).toEqual({
      jobId: 'j', userId: 'u', requestId: REQ, state: 'auth_done', pseudonymEmail: 'p', authEmailDone: true, authSessionsDone: false, authIdentitiesDone: true, lastErrorCode: null,
    });
  });
});

function runDeps(overrides: Partial<WorkspaceDeletionRunDeps> = {}): WorkspaceDeletionRunDeps & { removed: string[][]; marked: string[][]; fails: string[] } {
  const removed: string[][] = [];
  const marked: string[][] = [];
  const fails: string[] = [];
  return {
    removed,
    marked,
    fails,
    due: async () => [WS],
    begin: async () => ({ ok: true, state: 'deleting', objects: [{ bucket: 'workspace-files', name: `${WS}/a` }, { bucket: 'branding-assets', name: `${WS}/logo.png` }] }),
    removeObjects: async (_bucket, names) => {
      removed.push(names);
      return { removed: names };
    },
    mark: async (_ws, _runner, objects) => {
      marked.push(objects.map((o) => `${o.bucket}:${o.name}`));
    },
    execute: async () => ({ ok: true, state: 'completed' }),
    fail: async (_ws, _runner, code) => {
      fails.push(code);
    },
    randomRunner: () => 'runner-1',
    log: () => undefined,
    ...overrides,
  };
}

describe('EINRICHTUNG-01 AP7 — Ausführung der Betriebslöschung (1.26, K3)', () => {
  it('L-05.1: Objekte je Bucket entfernt und vermerkt, dann completed', async () => {
    const d = runDeps();
    expect(await runWorkspaceDeletion(WS, d)).toBe('completed');
    expect(d.removed).toEqual([[`${WS}/logo.png`], [`${WS}/a`]]);
    expect(d.marked.flat()).toEqual([`branding-assets:${WS}/logo.png`, `workspace-files:${WS}/a`]);
    expect(d.fails).toEqual([]);
  });

  it('L-05.6: Storage-Fehler mitten in der Liste → deleting mit Restliste, keine Ausführung', async () => {
    const execute = vi.fn(async () => ({ ok: true, state: 'completed' }));
    const d = runDeps({
      removeObjects: async (_bucket, names) => ({ removed: names.slice(0, names.length - 1), error: 'storage_unavailable' }),
      execute,
    });
    expect(await runWorkspaceDeletion(WS, d)).toBe('deleting');
    expect(execute).not.toHaveBeenCalled();
    expect(d.fails).toEqual(['storage_unavailable']);
  });

  it('L-05.10: ein fremdes Objekt in der Arbeitsliste ist ein Fehler, kein Löschauftrag', async () => {
    const d = runDeps({
      begin: async () => ({ ok: true, state: 'deleting', objects: [{ bucket: 'workspace-files', name: `${WS}/../anderer/x` }] }),
    });
    expect(await runWorkspaceDeletion(WS, d)).toBe('error');
    expect(d.removed).toEqual([]);
    expect(d.fails).toEqual(['worklist_foreign_object']);
    const fremd = '00000000-0000-4000-8000-0000000007a2';
    expect(isOwnDeletionObject(WS, { bucket: 'workspace-files', name: `${WS}/ok` })).toBe(true);
    expect(isOwnDeletionObject(WS, { bucket: 'workspace-files', name: `${fremd}/x` })).toBe(false);
    expect(isOwnDeletionObject(WS, { bucket: 'workspace-files', name: `${WS}/./x` })).toBe(false);
    expect(isOwnDeletionObject(WS, { bucket: 'workspace-files', name: `${WS}\\x` })).toBe(false);
    expect(isOwnDeletionObject(WS, { bucket: 'fremder-bucket', name: `${WS}/x` })).toBe(false);
  });

  it('L-05.5/L-04.4: fremde Sperre, nicht fällig, nicht beantragt; abgeschlossen bleibt abgeschlossen', async () => {
    expect(await runWorkspaceDeletion(WS, runDeps({ begin: async () => ({ ok: false, code: 'deletion_locked' }) }))).toBe('locked');
    expect(await runWorkspaceDeletion(WS, runDeps({ begin: async () => ({ ok: false, code: 'deletion_not_due' }) }))).toBe('not_due');
    expect(await runWorkspaceDeletion(WS, runDeps({ begin: async () => ({ ok: false, code: 'deletion_not_requested' }) }))).toBe('not_requested');
    expect(await runWorkspaceDeletion(WS, runDeps({ begin: async () => ({ ok: true, state: 'completed' }) }))).toBe('completed');
    expect(await runWorkspaceDeletion('kein-ws', runDeps())).toBe('error');
    const gesperrt = runDeps({ execute: async () => ({ ok: false, code: 'deletion_locked' }) });
    expect(await runWorkspaceDeletion(WS, gesperrt)).toBe('locked');
  });

  it('Lauf über alle fälligen Betriebe: Ausnahmen zählen als Fehler; ungültige Kennung abgewiesen', async () => {
    const d = runDeps({ due: async () => [WS, '00000000-0000-4000-8000-0000000007a3'], begin: async (ws) => { if (ws !== WS) throw new Error('x'); return { ok: true, state: 'completed' }; } });
    expect(await runWorkspaceDeletionBatch({}, d)).toEqual({ ok: true, results: { completed: 1, deleting: 0, locked: 0, not_due: 0, not_requested: 0, error: 1 } });
    expect(await runWorkspaceDeletionBatch({ workspaceId: 'x' }, d)).toEqual({ ok: false, error: 'invalid_request' });
  });
});

describe('EINRICHTUNG-01 AP7 — Dienstwege nur für Planer und Dienstrolle', () => {
  const anfrage = (headers: Record<string, string>) => new Request('https://example.invalid/fn', { method: 'POST', headers });

  it('Dienstrollen-Schlüssel, Planer-Geheimnis; sonst abgewiesen', async () => {
    const pruefe = vi.fn(async (_name: string, secret: string) => secret === 's'.repeat(40));
    expect(await isSchedulerOrServiceCall(anfrage({ Authorization: 'Bearer dienst-schluessel' }), 'dienst-schluessel', 'name', pruefe)).toBe(true);
    expect(await isSchedulerOrServiceCall(anfrage({ Authorization: 'Bearer nutzer-jwt' }), 'dienst-schluessel', 'name', pruefe)).toBe(false);
    expect(await isSchedulerOrServiceCall(anfrage({ 'x-officetakt-scheduler': 's'.repeat(40) }), 'dienst-schluessel', 'name', pruefe)).toBe(true);
    expect(await isSchedulerOrServiceCall(anfrage({ 'x-officetakt-scheduler': 'kurz' }), 'dienst-schluessel', 'name', pruefe)).toBe(false);
    expect(await isSchedulerOrServiceCall(anfrage({ 'x-officetakt-scheduler': 't'.repeat(40) }), 'dienst-schluessel', 'name', pruefe)).toBe(false);
    expect(await isSchedulerOrServiceCall(anfrage({}), 'dienst-schluessel', 'name', pruefe)).toBe(false);
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
