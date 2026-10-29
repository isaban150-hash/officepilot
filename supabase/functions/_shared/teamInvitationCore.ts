/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.5, M-17) — Einladungsmail: Entscheidungen ohne Deno-APIs, damit Vitest sie prüft.
 *
 * Ablauf: Eingabe prüfen → Kontext beim Server mit dem Token der einladenden Person laden (die zentrale Regel, die
 * Matrix und der Token-Hash entscheiden dort) → Linkbasis gegen die erlaubten Adressen der App prüfen →
 * Testempfänger-Schutz → Anbieter. Das Token steht nur im Link der Mail: nie in einem Protokoll, nie in der Antwort.
 */
import type { EmailProviderAdapter } from './emailProvider.ts';
import type { TestRecipientAllowlist } from './sendDocumentCore.ts';

export type InvitationLanguage = 'de' | 'tr' | 'bg';

export interface InvitationMailContext {
  email: string;
  role: 'admin' | 'member';
  workspaceName: string;
  inviterName: string | null;
  expiresAt: string;
}

export type TeamInvitationOutcome =
  | { ok: true; sent: true }
  | { ok: true; sent: false; reason: 'provider' | 'recipient' | 'network' | 'auth' | 'unknown' | 'test_recipient_blocked' | 'reply_to_unavailable' }
  | { ok: false; error: 'invalid_request' | 'forbidden' | 'not_open' | 'link_not_allowed' | 'server_error' };

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Erlaubte Adressen der App für den Link: APP_ALLOWED_ORIGINS (kommagetrennt); ohne Angabe nur lokale Adressen. */
export function isAllowedLinkBase(linkBase: string, configured: string | undefined | null): boolean {
  let origin: string;
  try {
    const parsed = new URL(linkBase);
    if (parsed.origin !== linkBase.replace(/\/+$/, '')) return false;
    origin = parsed.origin;
  } catch {
    return false;
  }
  const allowed = (configured ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (allowed.length > 0) return allowed.includes(origin);
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const ROLE_TEXT: Record<InvitationLanguage, Record<'admin' | 'member', string>> = {
  de: { admin: 'Admin', member: 'Mitglied' },
  tr: { admin: 'Yönetici', member: 'Üye' },
  bg: { admin: 'Администратор', member: 'Член' },
};

export function buildInvitationMail(
  context: InvitationMailContext,
  link: string,
  language: InvitationLanguage,
): { subject: string; text: string } {
  const role = ROLE_TEXT[language][context.role];
  const expires = context.expiresAt.slice(0, 10);
  const inviter = context.inviterName ?? '';
  switch (language) {
    case 'tr':
      return {
        subject: `„${context.workspaceName}“ işletmesine davet`,
        text: `${inviter ? `${inviter} sizi OfficeTakt'ta „${context.workspaceName}“ işletmesine ${role} olarak davet ediyor.` : `OfficeTakt'ta „${context.workspaceName}“ işletmesine ${role} olarak davet edildiniz.`}\n\nDaveti kabul etmek için bu bağlantıyı açın (${expires} tarihine kadar geçerli):\n${link}\n\nDaveti beklemiyorsanız bu e-postayı yok sayabilirsiniz.`,
      };
    case 'bg':
      return {
        subject: `Покана за „${context.workspaceName}“`,
        text: `${inviter ? `${inviter} ви кани` : 'Поканени сте'} в OfficeTakt във фирмата „${context.workspaceName}“ като ${role}.\n\nЗа да приемете поканата, отворете тази връзка (валидна до ${expires}):\n${link}\n\nАко не очаквате тази покана, можете да игнорирате имейла.`,
      };
    default:
      return {
        subject: `Einladung zu „${context.workspaceName}“`,
        text: `${inviter ? `${inviter} lädt Sie` : 'Sie sind'} in OfficeTakt in den Betrieb „${context.workspaceName}“ als ${role} ein${inviter ? '' : 'geladen'}.\n\nZum Annehmen öffnen Sie diesen Link (gültig bis ${expires}):\n${link}\n\nWenn Sie keine Einladung erwarten, können Sie diese E-Mail ignorieren.`,
      };
  }
}

export interface TeamInvitationDeps {
  senderEmail: string;
  allowedOrigins: string | undefined | null;
  testRecipientAllowlist: TestRecipientAllowlist;
  provider: EmailProviderAdapter;
  /**
   * EINRICHTUNG-01 (AP6; E18, K4) — Antwortadresse der Einladungsmail, mit dem Token der einladenden Person vom Server
   * bestimmt (bestätigte Antwortadresse des Betriebs, sonst bestätigte Anmelde-E-Mail des Inhabers). Eine Adresse aus
   * der Anfrage gilt nie. Fehlt sie, wird nicht gesendet (der Link bleibt zum Kopieren).
   */
  resolveReplyTo(invitationId: string): Promise<{ ok: true; email: string } | { ok: false }>;
  /** Kontext mit dem Token der einladenden Person; der Server prüft Rolle, Lizenz, Status und Hash. */
  loadContext(invitationId: string, token: string): Promise<{ ok: true; context: InvitationMailContext } | { ok: false; error: 'forbidden' | 'not_open' }>;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export async function runSendTeamInvitation(
  input: { invitationId: unknown; token: unknown; language: unknown; linkBase: unknown },
  deps: TeamInvitationDeps,
): Promise<TeamInvitationOutcome> {
  const invitationId = typeof input.invitationId === 'string' ? input.invitationId.trim() : '';
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const linkBase = typeof input.linkBase === 'string' ? input.linkBase.trim() : '';
  const language: InvitationLanguage = input.language === 'tr' || input.language === 'bg' ? input.language : 'de';
  if (!UUID.test(invitationId) || token.length < 20 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, error: 'invalid_request' };
  }
  if (!isAllowedLinkBase(linkBase, deps.allowedOrigins)) {
    deps.log({ outcome: 'link_not_allowed' });
    return { ok: false, error: 'link_not_allowed' };
  }
  const loaded = await deps.loadContext(invitationId, token);
  if (!loaded.ok) {
    deps.log({ outcome: loaded.error });
    return { ok: false, error: loaded.error };
  }
  const recipient = loaded.context.email.trim().toLowerCase();
  if (deps.testRecipientAllowlist.mode === 'invalid') {
    deps.log({ outcome: 'test_recipient_allowlist_invalid' });
    return { ok: true, sent: false, reason: 'test_recipient_blocked' };
  }
  if (deps.testRecipientAllowlist.mode === 'on' && !deps.testRecipientAllowlist.recipients.includes(recipient)) {
    deps.log({ outcome: 'test_recipient_blocked' });
    return { ok: true, sent: false, reason: 'test_recipient_blocked' };
  }
  const replyTo = await deps.resolveReplyTo(invitationId);
  if (!replyTo.ok) {
    deps.log({ outcome: 'reply_to_unavailable' });
    return { ok: true, sent: false, reason: 'reply_to_unavailable' };
  }
  const link = `${linkBase.replace(/\/+$/, '')}/einladung/${encodeURIComponent(token)}?email=${encodeURIComponent(recipient)}`;
  const mail = buildInvitationMail(loaded.context, link, language);
  const result = await deps.provider.sendTransactionalEmail({
    from: { email: deps.senderEmail, name: 'OfficeTakt' },
    replyTo: { email: replyTo.email, name: 'OfficeTakt' },
    to: { email: recipient },
    subject: mail.subject,
    text: mail.text,
    idempotencyKey: `team-invitation:${invitationId}:${token.slice(0, 8)}`,
  });
  if (result.accepted) {
    deps.log({ outcome: 'sent', provider: deps.provider.provider });
    return { ok: true, sent: true };
  }
  deps.log({ outcome: 'not_sent', category: result.errorCategory });
  const reason = ['provider', 'recipient', 'network', 'auth'].includes(result.errorCategory)
    ? (result.errorCategory as 'provider' | 'recipient' | 'network' | 'auth')
    : 'unknown';
  return { ok: true, sent: false, reason };
}
