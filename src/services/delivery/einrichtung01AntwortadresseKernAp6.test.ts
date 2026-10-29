/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-03, E-06; E18, K4) — Edge-Kerne ohne Deno-APIs.
 *
 *   confirm-reply-to „request“  Rolle/Lizenz/Fristen prüft der Server (`issue`); der Kern prüft Eingabe, Linkbasis,
 *                               Testempfänger-Schutz; nur der Hash verlässt den Kern; Token nie in Protokoll oder Antwort
 *   confirm-reply-to „confirm“  einheitliche Antwort für ungültige, abgelaufene, veraltete und fremde Tokens (E-03.3,
 *                               E-03.7, E-03.13); Versuchslimit; höchstens die maskierte Adresse in der Antwort
 *   mail-status                 nur Modus, keine Adressen (E-06.1–E-06.3)
 *
 * Synthetische Werte, kein Netz.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildReplyToConfirmLink,
  buildReplyToConfirmMail,
  bytesToBase64Url,
  REPLY_TO_CONFIRM_PATH,
  REPLY_TO_TOKEN_PATTERN,
  runReplyToConfirm,
  runReplyToRequest,
  type ReplyToConfirmDeps,
  type ReplyToRequestDeps,
} from '../../../supabase/functions/_shared/replyToConfirmCore';
import { resolveMailStatusMode, runMailStatus } from '../../../supabase/functions/_shared/mailStatusCore';
import type { EmailProviderAdapter, SendTransactionalEmailInput } from '../../../supabase/functions/_shared/emailProvider';

const WORKSPACE = '00000000-0000-4000-8000-0000000003e3';
const USER = '00000000-0000-4000-8000-00000000a001';
const LINK_BASE = 'http://127.0.0.1:5240';
const TOKEN = bytesToBase64Url(new Uint8Array(32).fill(7));

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function provider(accepted = true) {
  const sent: SendTransactionalEmailInput[] = [];
  const adapter: EmailProviderAdapter = {
    provider: 'stub',
    async sendTransactionalEmail(input) {
      sent.push(input);
      return accepted
        ? { accepted: true, providerMessageId: 'stub-1', providerStatus: 'accepted' }
        : { accepted: false, errorCategory: 'provider', errorCode: 'x', errorMessageSafe: 'x', handoffUncertain: false };
    },
  };
  return { adapter, sent };
}

function requestDeps(overrides: Partial<ReplyToRequestDeps> = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const calls = { issue: [] as unknown[][], markSent: [] as unknown[][], withdraw: [] as unknown[][] };
  const { adapter, sent } = provider();
  const deps: ReplyToRequestDeps = {
    senderEmail: 'noreply@officetakt.invalid',
    allowedOrigins: LINK_BASE,
    testRecipientAllowlist: { mode: 'off' },
    provider: adapter,
    randomToken: () => TOKEN,
    sha256Hex,
    async issue(...args) {
      calls.issue.push(args);
      return { ok: true, address: 'antwort@beispiel.invalid', expiresAt: '2026-10-28T10:00:00.000Z' };
    },
    async markSent(...args) {
      calls.markSent.push(args);
    },
    async withdraw(...args) {
      calls.withdraw.push(args);
    },
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, calls, logs, sent };
}

const REQUEST = { userId: USER, workspaceId: WORKSPACE, address: ' Antwort@Beispiel.invalid ', linkBase: LINK_BASE, language: 'de' };

describe('confirm-reply-to „request“', () => {
  it('erzeugt ein 256-Bit-Token, gibt nur den Hash an den Server und schickt den Link im Fragment', async () => {
    const { deps, calls, logs, sent } = requestDeps();
    const outcome = await runReplyToRequest(REQUEST, deps);

    expect(outcome).toEqual({ ok: true, sent: true, expiresAt: '2026-10-28T10:00:00.000Z' });
    expect(REPLY_TO_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    const tokenHash = await sha256Hex(TOKEN);
    expect(calls.issue).toEqual([[WORKSPACE, USER, tokenHash, 'antwort@beispiel.invalid']]);
    expect(calls.markSent).toEqual([[tokenHash, USER]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual({ email: 'antwort@beispiel.invalid' });
    expect(sent[0]!.text).toContain(`${LINK_BASE}${REPLY_TO_CONFIRM_PATH}#token=${TOKEN}`);
    // Das Token steht nur im Link der Mail — nie im Idempotenzschlüssel, nie im Protokoll, nie in der Antwort.
    expect(sent[0]!.idempotencyKey).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain('antwort@beispiel.invalid');
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it('weist ohne Anmeldung, mit ungültiger Eingabe oder fremder Linkbasis ab — ohne Server-Aufruf', async () => {
    for (const [input, error] of [
      [{ ...REQUEST, userId: null }, 'unauthenticated'],
      [{ ...REQUEST, workspaceId: 'kein-betrieb' }, 'invalid_request'],
      [{ ...REQUEST, address: 'keine-adresse' }, 'invalid_request'],
      [{ ...REQUEST, linkBase: 'https://fremd.example' }, 'link_not_allowed'],
      [{ ...REQUEST, linkBase: `${LINK_BASE}/pfad` }, 'link_not_allowed'],
    ] as const) {
      const { deps, calls } = requestDeps();
      expect(await runReplyToRequest(input, deps), JSON.stringify(input)).toEqual({ ok: false, error });
      expect(calls.issue).toEqual([]);
    }
  });

  it('reicht die Serverentscheidungen durch (Rolle, Adresse, Fristen) und verschickt dann nichts', async () => {
    for (const code of ['forbidden', 'reply_to_missing', 'address_mismatch', 'already_confirmed', 'resend_too_early', 'resend_limit']) {
      const { deps, sent } = requestDeps({
        async issue() {
          return { ok: false, code, retryAfter: code === 'resend_too_early' ? '2026-10-25T10:10:00.000Z' : undefined };
        },
      });
      const outcome = await runReplyToRequest(REQUEST, deps);
      expect(outcome).toMatchObject({ ok: false, error: code });
      if (code === 'resend_too_early') expect(outcome).toMatchObject({ retryAfter: '2026-10-25T10:10:00.000Z' });
      expect(sent).toEqual([]);
    }
    const { deps } = requestDeps({ async issue() { return { ok: false, code: 'something_else' }; } });
    expect(await runReplyToRequest(REQUEST, deps)).toEqual({ ok: false, error: 'server_error' });
  });

  it('Testempfänger-Liste: eine nicht freigegebene Adresse erhält nichts; die Ausgabe wird zurückgezogen', async () => {
    const { deps, calls, sent } = requestDeps({ testRecipientAllowlist: { mode: 'on', recipients: ['frei@beispiel.invalid'] } });
    expect(await runReplyToRequest(REQUEST, deps)).toEqual({ ok: true, sent: false, reason: 'test_recipient_blocked' });
    expect(sent).toEqual([]);
    expect(calls.withdraw).toEqual([[await sha256Hex(TOKEN)]]);
    expect(calls.markSent).toEqual([]);
  });

  it('ein abgelehnter Versand zählt nicht als Versand (zurückgezogen statt festgehalten)', async () => {
    const { adapter } = provider(false);
    const { deps, calls } = requestDeps({ provider: adapter });
    expect(await runReplyToRequest(REQUEST, deps)).toEqual({ ok: true, sent: false, reason: 'provider' });
    expect(calls.withdraw).toHaveLength(1);
    expect(calls.markSent).toEqual([]);
  });

  it('Mailtext in der Betriebssprache (de, tr, bg) mit Link und Ablaufzeit', () => {
    const link = buildReplyToConfirmLink(`${LINK_BASE}/`, TOKEN);
    expect(link).toBe(`${LINK_BASE}/antwortadresse-bestaetigen#token=${TOKEN}`);
    const input = { address: 'antwort@beispiel.invalid', link, expiresAt: '2026-10-28T10:00:00.000Z' };
    expect(buildReplyToConfirmMail(input, 'de').subject).toContain('Antwortadresse bestätigen');
    expect(buildReplyToConfirmMail(input, 'tr').subject).toContain('Yanıt adresini onaylayın');
    expect(buildReplyToConfirmMail(input, 'bg').subject).toContain('Потвърдете');
    for (const language of ['de', 'tr', 'bg'] as const) {
      const mail = buildReplyToConfirmMail(input, language);
      expect(mail.text).toContain(link);
      expect(mail.text).toContain('2026-10-28 10:00');
    }
  });
});

describe('confirm-reply-to „confirm“', () => {
  function confirmDeps(result: Awaited<ReturnType<ReplyToConfirmDeps['confirm']>>) {
    const calls: unknown[][] = [];
    const logs: Array<Record<string, unknown>> = [];
    const deps: ReplyToConfirmDeps = {
      sha256Hex,
      async confirm(...args) {
        calls.push(args);
        return result;
      },
      log: (entry) => logs.push(entry),
    };
    return { deps, calls, logs };
  }

  it('bestätigt über den Hash; die Antwort trägt höchstens die maskierte Adresse', async () => {
    const { deps, calls, logs } = confirmDeps({ ok: true, status: 'confirmed', address: 'a***@beispiel.invalid' });
    const outcome = await runReplyToConfirm({ token: TOKEN, attemptSource: '198.51.100.7' }, deps);
    expect(outcome).toEqual({ ok: true, status: 'confirmed', address: 'a***@beispiel.invalid' });
    expect(calls).toEqual([[await sha256Hex(TOKEN), await sha256Hex('reply-to-confirm:198.51.100.7')]]);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('E-03.8: die Wiederholung derselben Bestätigung ist idempotent', async () => {
    const { deps } = confirmDeps({ ok: true, status: 'already_confirmed', address: null });
    expect(await runReplyToConfirm({ token: TOKEN, attemptSource: null }, deps)).toEqual({ ok: true, status: 'already_confirmed', address: null });
  });

  it('E-03.3/E-03.7/E-03.13: ungültig, abgelaufen, veraltet, fremd — dieselbe Antwort', async () => {
    for (const code of ['invalid', 'expired', 'superseded', 'stale', 'foreign', undefined]) {
      const { deps } = confirmDeps({ ok: false, code });
      expect(await runReplyToConfirm({ token: TOKEN, attemptSource: null }, deps), String(code)).toEqual({ ok: false, error: 'invalid' });
    }
  });

  it('ein Token in falscher Form zählt wie ein ungültiges (gleicher Weg, gleicher Versuchszähler)', async () => {
    const { deps, calls } = confirmDeps({ ok: false, code: 'invalid' });
    expect(await runReplyToConfirm({ token: 'zu-kurz', attemptSource: '198.51.100.7' }, deps)).toEqual({ ok: false, error: 'invalid' });
    expect(calls[0]?.[0]).toBe('0'.repeat(64));
    expect(calls[0]?.[1]).toBe(await sha256Hex('reply-to-confirm:198.51.100.7'));
  });

  it('Versuchslimit: gemeldet als „zu viele Versuche“', async () => {
    const { deps } = confirmDeps({ ok: false, code: 'rate_limited' });
    expect(await runReplyToConfirm({ token: TOKEN, attemptSource: '198.51.100.7' }, deps)).toEqual({ ok: false, error: 'rate_limited' });
  });
});

describe('mail-status (E-06)', () => {
  it('Modus aus Anbieter und Testempfänger-Liste — ohne Adressen', () => {
    expect(resolveMailStatusMode('stub', { mode: 'off' })).toBe('stub');
    expect(resolveMailStatusMode('stub', { mode: 'on', recipients: ['a@beispiel.invalid'] })).toBe('stub');
    expect(resolveMailStatusMode('brevo', { mode: 'on', recipients: ['a@beispiel.invalid'] })).toBe('test_recipients');
    expect(resolveMailStatusMode('brevo', { mode: 'off' })).toBe('live');
    expect(resolveMailStatusMode(null, { mode: 'off' })).toBe('misconfigured');
    expect(resolveMailStatusMode('brevo', { mode: 'invalid' })).toBe('misconfigured');
  });

  it('E-06.3: ohne Anmeldung bzw. ohne aktive Mitgliedschaft keine Auskunft; Mitglieder erhalten nur den Modus', async () => {
    const accessDenial = vi.fn(async (_workspace: string, user: string) => (user === USER ? null : 'not_member'));
    const deps = { providerName: 'brevo', allowlist: { mode: 'on' as const, recipients: ['geheim@beispiel.invalid'] }, accessDenial };

    expect(await runMailStatus({ userId: null, workspaceId: WORKSPACE }, deps)).toEqual({ ok: false, error: 'unauthenticated' });
    expect(await runMailStatus({ userId: USER, workspaceId: 'x' }, deps)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await runMailStatus({ userId: '00000000-0000-4000-8000-00000000f00d', workspaceId: WORKSPACE }, deps)).toEqual({ ok: false, error: 'forbidden' });
    const ok = await runMailStatus({ userId: USER, workspaceId: WORKSPACE }, deps);
    expect(ok).toEqual({ ok: true, mode: 'test_recipients' });
    expect(JSON.stringify(ok)).not.toContain('geheim@');
  });
});
