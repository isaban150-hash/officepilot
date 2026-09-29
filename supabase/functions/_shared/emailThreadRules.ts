/**
 * E-MAIL 07F-01A — Regeln für Antworten und Gesprächsverläufe (Threads),
 * ohne Deno- und Supabase-Abhängigkeit (Server-Import und Oberfläche nutzen
 * dieselbe Datei, Vitest prüft sie direkt).
 *
 * Thread-Zuordnung (Datenbank, `email_resolve_thread`):
 *   1. explizite OfficeTakt-thread_id (Antwort aus OfficeTakt),
 *   2. In-Reply-To → bekannte Message-ID,
 *   3. References → bekannte Message-ID (neueste zuerst),
 *   4. Microsoft conversationId nur als unterstützendes Signal (gleiches
 *      Postfach UND Absender ist Teilnehmer des Verlaufs),
 *   5. nie der Betreff allein.
 *
 * Message-IDs werden hier nur normalisiert (ohne spitze Klammern, klein),
 * nie erfunden: ausgehend gilt die vom Versanddienst gelieferte ID.
 */

/** RFC-5322-Message-ID normalisieren: ohne `<>`/Leerraum, klein; ungültig → null. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  if (!trimmed || trimmed.length > 900 || /[\s<>]/.test(trimmed) || !trimmed.includes('@')) return null;
  return trimmed.toLowerCase();
}

/** Liste aus In-Reply-To/References (`<a@x> <b@y>`), normalisiert, ohne Dubletten, Reihenfolge bleibt. */
export function parseMessageIdList(value: string | null | undefined, max = 30): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const bracketed = value.match(/<[^<>\s]+>/g);
  const tokens = bracketed ?? value.split(/[\s,]+/);
  const result: string[] = [];
  for (const token of tokens) {
    const id = normalizeMessageId(token);
    if (id && !result.includes(id)) result.push(id);
  }
  // Nur die jüngsten Einträge behalten (References wächst mit jeder Antwort).
  return result.slice(-max);
}

/** References einer Antwort: Kette des Originals + dessen Message-ID (höchstens `max`, jüngste zuletzt). */
export function buildReplyReferences(parentReferences: readonly string[], parentMessageId: string | null | undefined, max = 30): string[] {
  const result: string[] = [];
  for (const entry of [...parentReferences, parentMessageId ?? '']) {
    const id = normalizeMessageId(entry);
    if (id && !result.includes(id)) result.push(id);
  }
  return result.slice(-max);
}

/** Antwort-Präfixe (DE/EN/TR/BG und gängige Varianten), nie Weiterleitungs-Präfixe. */
const REPLY_PREFIX = /^\s*(?:(?:re|aw|antw|antwort|sv|ynt|cvp|отг|отговор)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i;

/** „Re: <Betreff>" ohne „Re: Re: AW:"-Ketten. */
export function normalizeReplySubject(subject: string | null | undefined, maxLength = 255): string {
  const rest = (subject ?? '').replace(REPLY_PREFIX, '').trim();
  const result = rest ? `Re: ${rest}` : 'Re:';
  return result.length > maxLength ? result.slice(0, maxLength).trimEnd() : result;
}

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;
/** Technische Absender, an die nie geantwortet wird. */
const NO_REPLY_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|postmaster|bounces?|notifications?[-_.]?noreply)(?:[+._-].*)?$/i;

export function isNoReplyAddress(address: string): boolean {
  const local = address.trim().toLowerCase().split('@')[0] ?? '';
  return NO_REPLY_LOCAL.test(local);
}

export type ReplyRecipientProblem = 'missing' | 'invalid' | 'own_address' | 'no_reply';

export interface ReplyRecipientResult {
  /** Vorbelegung „An" — leer, wenn der Empfänger nicht sicher bestimmbar ist. */
  to: string[];
  /** Vorbelegung „Cc" (nur Cc des Originals; nie Bcc, nie eigene Adressen). */
  cc: string[];
  source: 'reply_to' | 'from' | null;
  /** Gesetzt, wenn der Benutzer den Empfänger selbst wählen muss. */
  problem: ReplyRecipientProblem | null;
}

/**
 * Empfänger einer Antwort: gültiges Reply-To vor From. Nie an eigene
 * Firmenadressen, ungültige oder technische No-Reply-/Bounce-Adressen —
 * dann bleibt „An" leer und der Benutzer wählt selbst (keine stille
 * Fehladressierung).
 */
export function resolveReplyRecipients(
  message: { fromAddress?: string | null; replyToAddresses?: readonly string[] | null; cc?: readonly string[] | null },
  ownAddresses: readonly string[],
): ReplyRecipientResult {
  const own = new Set(ownAddresses.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const check = (address: string): ReplyRecipientProblem | null => {
    if (!address) return 'missing';
    if (address.length > 254 || !ADDRESS.test(address)) return 'invalid';
    if (own.has(address)) return 'own_address';
    if (isNoReplyAddress(address)) return 'no_reply';
    return null;
  };
  const clean = (list: readonly string[] | null | undefined) => [...new Set((list ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];

  let to: string[] = [];
  let source: ReplyRecipientResult['source'] = null;
  let problem: ReplyRecipientProblem | null = null;
  const replyTo = clean(message.replyToAddresses);
  const validReplyTo = replyTo.filter((address) => check(address) === null);
  if (validReplyTo.length > 0) {
    to = validReplyTo.slice(0, 5);
    source = 'reply_to';
  } else {
    const from = (message.fromAddress ?? '').trim().toLowerCase();
    const fromProblem = check(from);
    if (fromProblem === null) {
      to = [from];
      source = 'from';
    } else {
      // Ein unbrauchbares Reply-To hat Vorrang in der Begründung (z. B. nur no-reply angegeben).
      problem = replyTo.length > 0 ? check(replyTo[0]) ?? fromProblem : fromProblem;
    }
  }
  const cc = clean(message.cc).filter((address) => check(address) === null && !to.includes(address)).slice(0, 10);
  return { to, cc, source, problem };
}

/** Kompaktes Textzitat des Originals (keine HTML-Übernahme, begrenzt). */
export function buildQuotedReply(
  original: { bodyText: string; senderLabel: string; dateLabel: string },
  labels: { wrote: string },
  limits: { maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = limits.maxLines ?? 20;
  const maxChars = limits.maxChars ?? 2000;
  const text = (original.bodyText ?? '').replace(/\r\n?/g, '\n').trim();
  let lines = text ? text.split('\n') : [];
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  let body = lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
  if (body.length > maxChars) {
    body = body.slice(0, maxChars).replace(/\n[^\n]*$/, '');
    truncated = true;
  }
  const head = labels.wrote.replace('{date}', original.dateLabel).replace('{sender}', original.senderLabel);
  return `${head}\n${body}${truncated ? '\n> …' : ''}`;
}
