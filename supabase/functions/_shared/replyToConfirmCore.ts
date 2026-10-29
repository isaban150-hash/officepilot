/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-03, Entscheidung E18, Korrekturgruppe K4) — Bestätigung der Antwortadresse,
 * Entscheidungen ohne Deno-APIs, damit Vitest sie prüft.
 *
 * „request“ (angemeldet, Inhaber oder Admin): Linkbasis gegen APP_ALLOWED_ORIGINS → Token (256 Bit Zufall) erzeugen →
 * beim Server ausgeben (nur der SHA-256 wird gespeichert; Rolle, Lizenz, Adresse, Fristen prüft der Server) →
 * Testempfänger-Schutz → Anbieter → angenommen: festhalten; gescheitert: zurückziehen (zählt nicht als Versand).
 * Das Token steht nur im Link der Mail, im Fragment hinter „#“ (erreicht keinen Server-Log): nie in einem Protokoll,
 * nie in der Antwort.
 *
 * „confirm“ (ohne Anmeldung, nur POST): Token prüfen → Hash → Server bestätigt nur, wenn Zweck, Betrieb, Adresse und
 * Änderungsstand aktuell sind. Ungültige, abgelaufene, veraltete und fremde Tokens erhalten dieselbe Antwort; die
 * Antwort enthält höchstens die maskierte Adresse. Kein Zugang, keine Sitzung, keine Geschäftsdaten.
 */
import type { EmailProviderAdapter } from './emailProvider.ts';
import type { TestRecipientAllowlist } from './sendDocumentCore.ts';
import { isAllowedLinkBase } from './teamInvitationCore.ts';

export type ReplyToLanguage = 'de' | 'tr' | 'bg';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 32 Byte als base64url ohne Auffüllung: 43 Zeichen. */
export const REPLY_TO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const REPLY_TO_CONFIRM_PATH = '/antwortadresse-bestaetigen';

export function buildReplyToConfirmLink(linkBase: string, token: string): string {
  return `${linkBase.replace(/\/+$/, '')}${REPLY_TO_CONFIRM_PATH}#token=${encodeURIComponent(token)}`;
}

export function buildReplyToConfirmMail(
  input: { address: string; link: string; expiresAt: string },
  language: ReplyToLanguage,
): { subject: string; text: string } {
  const bis = input.expiresAt.slice(0, 16).replace('T', ' ');
  switch (language) {
    case 'tr':
      return {
        subject: 'OfficeTakt: Yanıt adresini onaylayın',
        text: `Bu adres (${input.address}) OfficeTakt'ta bir işletmenin e-postaları için yanıt adresi olarak girildi.\n\nAdresi onaylamak için bu bağlantıyı açın ve „Adresi onayla“ düğmesine basın (${bis} UTC tarihine kadar geçerli):\n${input.link}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın. Onaylanmadığı sürece adres kullanılmaz.`,
      };
    case 'bg':
      return {
        subject: 'OfficeTakt: Потвърдете адреса за отговор',
        text: `Този адрес (${input.address}) е въведен в OfficeTakt като адрес за отговор за имейлите на фирма.\n\nЗа да потвърдите адреса, отворете тази връзка и натиснете „Потвърждаване на адреса“ (валидна до ${bis} UTC):\n${input.link}\n\nАко не сте поискали това, игнорирайте имейла. Без потвърждение адресът не се използва.`,
      };
    default:
      return {
        subject: 'OfficeTakt: Antwortadresse bestätigen',
        text: `Diese Adresse (${input.address}) wurde in OfficeTakt als Antwortadresse für die E-Mails eines Betriebs eingetragen.\n\nZum Bestätigen öffnen Sie diesen Link und wählen „Adresse bestätigen“ (gültig bis ${bis} UTC):\n${input.link}\n\nWenn Sie das nicht veranlasst haben, ignorieren Sie diese E-Mail. Ohne Bestätigung wird die Adresse nicht verwendet.`,
      };
  }
}

export type ReplyToRequestOutcome =
  | { ok: true; sent: true; expiresAt: string }
  | { ok: true; sent: false; reason: 'provider' | 'recipient' | 'network' | 'auth' | 'unknown' | 'test_recipient_blocked' }
  | {
      ok: false;
      error:
        | 'invalid_request'
        | 'unauthenticated'
        | 'forbidden'
        | 'link_not_allowed'
        | 'reply_to_missing'
        | 'address_mismatch'
        | 'already_confirmed'
        | 'resend_too_early'
        | 'resend_limit'
        | 'server_error';
      retryAfter?: string;
    };

export interface ReplyToIssueResult {
  ok: boolean;
  code?: string;
  address?: string;
  expiresAt?: string;
  retryAfter?: string;
}

export interface ReplyToRequestDeps {
  senderEmail: string;
  allowedOrigins: string | undefined | null;
  testRecipientAllowlist: TestRecipientAllowlist;
  provider: EmailProviderAdapter;
  randomToken(): string;
  sha256Hex(value: string): Promise<string>;
  issue(workspaceId: string, actorUserId: string, tokenHash: string, address: string): Promise<ReplyToIssueResult>;
  markSent(tokenHash: string, actorUserId: string): Promise<void>;
  withdraw(tokenHash: string): Promise<void>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export async function runReplyToRequest(
  input: { userId: string | null; workspaceId: unknown; address: unknown; linkBase: unknown; language: unknown },
  deps: ReplyToRequestDeps,
): Promise<ReplyToRequestOutcome> {
  if (!input.userId) return { ok: false, error: 'unauthenticated' };
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
  const address = typeof input.address === 'string' ? input.address.trim().toLowerCase() : '';
  const linkBase = typeof input.linkBase === 'string' ? input.linkBase.trim() : '';
  const language: ReplyToLanguage = input.language === 'tr' || input.language === 'bg' ? input.language : 'de';
  if (!UUID.test(workspaceId) || !address || address.length > 254 || !EMAIL_PATTERN.test(address)) {
    return { ok: false, error: 'invalid_request' };
  }
  if (!isAllowedLinkBase(linkBase, deps.allowedOrigins)) {
    deps.log({ outcome: 'link_not_allowed' });
    return { ok: false, error: 'link_not_allowed' };
  }
  const token = deps.randomToken();
  if (!REPLY_TO_TOKEN_PATTERN.test(token)) return { ok: false, error: 'server_error' };
  const tokenHash = await deps.sha256Hex(token);
  const issued = await deps.issue(workspaceId, input.userId, tokenHash, address);
  if (!issued.ok) {
    const code = issued.code ?? 'server_error';
    deps.log({ outcome: code });
    const known = ['forbidden', 'reply_to_missing', 'address_mismatch', 'already_confirmed', 'resend_too_early', 'resend_limit', 'invalid_request'];
    return {
      ok: false,
      error: (known.includes(code) ? code : 'server_error') as Exclude<ReplyToRequestOutcome, { ok: true }>['error'],
      ...(issued.retryAfter ? { retryAfter: issued.retryAfter } : {}),
    };
  }
  const recipient = (issued.address ?? address).toLowerCase();
  if (deps.testRecipientAllowlist.mode === 'invalid' || (deps.testRecipientAllowlist.mode === 'on' && !deps.testRecipientAllowlist.recipients.includes(recipient))) {
    await deps.withdraw(tokenHash);
    deps.log({ outcome: 'test_recipient_blocked' });
    return { ok: true, sent: false, reason: 'test_recipient_blocked' };
  }
  const mail = buildReplyToConfirmMail({ address: recipient, link: buildReplyToConfirmLink(linkBase, token), expiresAt: issued.expiresAt ?? '' }, language);
  const result = await deps.provider.sendTransactionalEmail({
    from: { email: deps.senderEmail, name: 'OfficeTakt' },
    to: { email: recipient },
    subject: mail.subject,
    text: mail.text,
    idempotencyKey: `reply-to-confirm:${workspaceId}:${tokenHash.slice(0, 16)}`,
  });
  if (result.accepted) {
    await deps.markSent(tokenHash, input.userId);
    deps.log({ outcome: 'sent', provider: deps.provider.provider });
    return { ok: true, sent: true, expiresAt: issued.expiresAt ?? '' };
  }
  await deps.withdraw(tokenHash);
  deps.log({ outcome: 'not_sent', category: result.errorCategory });
  const reason = ['provider', 'recipient', 'network', 'auth'].includes(result.errorCategory)
    ? (result.errorCategory as 'provider' | 'recipient' | 'network' | 'auth')
    : 'unknown';
  return { ok: true, sent: false, reason };
}

export type ReplyToConfirmOutcome =
  | { ok: true; status: 'confirmed' | 'already_confirmed'; address: string | null }
  | { ok: false; error: 'invalid' | 'rate_limited' | 'server_error' };

export interface ReplyToConfirmDeps {
  sha256Hex(value: string): Promise<string>;
  confirm(tokenHash: string, attemptKey: string | null): Promise<{ ok: boolean; status?: string; code?: string; address?: string | null }>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export async function runReplyToConfirm(
  input: { token: unknown; attemptSource: string | null },
  deps: ReplyToConfirmDeps,
): Promise<ReplyToConfirmOutcome> {
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const attemptKey = input.attemptSource ? await deps.sha256Hex(`reply-to-confirm:${input.attemptSource}`) : null;
  // Ein Token in falscher Form zählt wie ein ungültiges (dieselbe Antwort, derselbe Versuchszähler).
  const tokenHash = REPLY_TO_TOKEN_PATTERN.test(token) ? await deps.sha256Hex(token) : '0'.repeat(64);
  const result = await deps.confirm(tokenHash, attemptKey);
  if (result.ok && (result.status === 'confirmed' || result.status === 'already_confirmed')) {
    deps.log({ outcome: result.status });
    return { ok: true, status: result.status, address: typeof result.address === 'string' ? result.address : null };
  }
  if (result.code === 'rate_limited') {
    deps.log({ outcome: 'rate_limited' });
    return { ok: false, error: 'rate_limited' };
  }
  deps.log({ outcome: 'invalid' });
  return { ok: false, error: 'invalid' };
}

/** Base64url ohne Auffüllung (Token). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
