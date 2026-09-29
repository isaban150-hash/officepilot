/**
 * E-MAIL 07F-01C — streng begrenzter Kontext für einen Antwortentwurf.
 *
 * Nur, was OfficeTakt zuverlässig und mandantensicher weiß:
 *   * die zu beantwortende E-Mail (Absendername, Betreff, Text, Eingangszeit),
 *   * höchstens drei vorherige Nachrichten desselben Verlaufs (je begrenzt),
 *   * Geschäftskontext NUR über eine vorhandene Kennung (customerId/vorgangId)
 *     aus dem lokalen Workspace-Bestand: Kundenname, Vorgangstitel/-status,
 *     Auftrags-/Angebotsnummer, Rechnungsnummern; Beträge nur, wenn genau EINE
 *     versendete Rechnung eindeutig ist,
 *   * der Firmenname.
 * Nie: Adressen, Anhangsinhalte, Termine/Liefertermine/Ansprechpartner als
 * Fakten, Daten anderer Kunden oder Workspaces. IBAN-/Steuerdaten werden mit
 * der bestehenden Maskierung entfernt, E-Mail-Adressen im Text ersetzt.
 */
import type { EmailMessage } from '../../types/emailMessage';
import type { Customer, Vorgang, VorgangInvoice } from '../../types/models';
import { sanitizeAiText } from '../ai/aiTextSanitizer';
import { isNoReplyAddress } from '../../../supabase/functions/_shared/emailThreadRules';

export const REPLY_AI_CURRENT_MAX_CHARS = 4000;
export const REPLY_AI_PREVIOUS_MAX_MESSAGES = 3;
export const REPLY_AI_PREVIOUS_MAX_CHARS = 1200;
export const REPLY_AI_MIN_TEXT_CHARS = 12;

export interface EmailReplyAiPreviousMessage {
  direction: 'inbound' | 'outbound';
  at: string;
  text: string;
}

export interface EmailReplyAiBusinessFacts {
  customerName?: string;
  vorgangTitle?: string;
  vorgangStatus?: string;
  orderNumber?: string;
  offerNumber?: string;
  invoices: Array<{ number: string; amount?: number; openAmount?: number }>;
}

export interface EmailReplyAiContext {
  current: { senderName: string; subject: string; text: string; receivedAt?: string; truncated: boolean };
  previous: EmailReplyAiPreviousMessage[];
  previousOmitted: number;
  business: EmailReplyAiBusinessFacts;
  companyName: string;
}

export type ReplySuitability = 'ok' | 'empty' | 'too_short' | 'automated';

const AUTOMATED_SUBJECT = /\b(automatische antwort|auto(?:matic)?[-\s]?reply|out of office|abwesenheit(?:snotiz)?|delivery status notification|undeliver(?:able|ed)|unzustellbar|mail delivery (?:failed|subsystem)|returned mail|otomatik yanıt|автоматичен отговор)\b/i;
const EMAIL_IN_TEXT = /[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+\.[a-z]{2,}/gi;

/** Zitierte Vorgeschichte (`> …`, „Am … schrieb …:") gehört nicht zur aktuellen Nachricht. */
export function stripQuotedHistory(text: string): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(am|on|le|el)\s.{3,120}(schrieb|wrote|a écrit|escribió)\s?.{0,80}:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(original|ursprüngliche)\s*(message|nachricht)/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Datenschutz: Masken für IBAN/Steuerdaten (bestehend) + E-Mail-Adressen. */
export function minimizeForPrompt(text: string): string {
  return sanitizeAiText(text ?? '').replace(EMAIL_IN_TEXT, '(E-Mail-Adresse)');
}

function limit(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return { text: `${(lastBreak > max * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trimEnd()} …`, truncated: true };
}

/** Eignet sich die Nachricht für einen Antwortentwurf? (keine Generierung für leere/automatische Mails) */
export function assessReplySuitability(message: Pick<EmailMessage, 'bodyText' | 'subject' | 'fromAddress'>): ReplySuitability {
  if (message.fromAddress && isNoReplyAddress(message.fromAddress)) return 'automated';
  if (AUTOMATED_SUBJECT.test(message.subject ?? '')) return 'automated';
  const text = stripQuotedHistory(message.bodyText ?? '');
  if (!text) return 'empty';
  if (text.replace(/[^\p{L}\p{N}]/gu, '').length < REPLY_AI_MIN_TEXT_CHARS) return 'too_short';
  return 'ok';
}

/** Wurde auf diese eingegangene Mail im Verlauf bereits geantwortet (ausgehend, danach, nicht fehlgeschlagen)? */
export function isAlreadyAnswered(parent: Pick<EmailMessage, 'id' | 'receivedAt' | 'createdAt'>, thread: EmailMessage[]): boolean {
  const since = Date.parse(parent.receivedAt ?? parent.createdAt ?? '') || 0;
  return thread.some((message) =>
    message.id !== parent.id
    && message.direction === 'outbound'
    && message.status !== 'failed'
    && (Date.parse(message.providerAcceptedAt ?? message.createdAt ?? '') || 0) > since);
}

export interface EmailReplyAiContextDeps {
  getCustomer(id: string): Pick<Customer, 'id' | 'name'> | undefined;
  getVorgang(id: string): Pick<Vorgang, 'id' | 'title' | 'status' | 'customerId' | 'orderNumber' | 'sourceOfferNumber' | 'invoices'> | undefined;
  openAmount(invoice: VorgangInvoice): number | undefined;
  companyName(): string;
}

function businessFacts(parent: EmailMessage, deps: EmailReplyAiContextDeps): EmailReplyAiBusinessFacts {
  const facts: EmailReplyAiBusinessFacts = { invoices: [] };
  // Nur über die Kennung der Nachricht — nie über Namen, Betreff oder Adresse geraten.
  const vorgang = parent.vorgangId ? deps.getVorgang(parent.vorgangId) : undefined;
  const customerId = parent.customerId ?? undefined;
  // Ein Vorgang eines anderen Kunden wird nie verwendet.
  const vorgangFits = vorgang && (!customerId || !vorgang.customerId || vorgang.customerId === customerId);
  const customer = customerId ? deps.getCustomer(customerId) : undefined;
  if (customer?.name?.trim()) facts.customerName = customer.name.trim();
  if (vorgang && vorgangFits) {
    if (vorgang.title?.trim()) facts.vorgangTitle = vorgang.title.trim();
    if (vorgang.status) facts.vorgangStatus = String(vorgang.status);
    if (vorgang.orderNumber) facts.orderNumber = vorgang.orderNumber;
    if (vorgang.sourceOfferNumber) facts.offerNumber = vorgang.sourceOfferNumber;
    const sent = (vorgang.invoices ?? []).filter((invoice) => invoice.status === 'versendet' && invoice.number);
    if (sent.length === 1) {
      // Genau eine versendete Rechnung: Betrag und offener Betrag sind eindeutig.
      const open = deps.openAmount(sent[0]);
      facts.invoices.push({ number: sent[0].number, amount: sent[0].amount, openAmount: open });
    } else {
      for (const invoice of sent.slice(0, 3)) facts.invoices.push({ number: invoice.number });
    }
  }
  return facts;
}

export function buildEmailReplyAiContext(parent: EmailMessage, thread: EmailMessage[], deps: EmailReplyAiContextDeps): EmailReplyAiContext {
  const current = limit(minimizeForPrompt(stripQuotedHistory(parent.bodyText ?? '')), REPLY_AI_CURRENT_MAX_CHARS);
  // Frühere Nachrichten desselben Verlaufs (nur dieser Thread), älteste zuerst, höchstens drei.
  const before = thread
    .filter((message) => message.id !== parent.id && (!parent.threadId || !message.threadId || message.threadId === parent.threadId))
    .filter((message) => message.direction === 'inbound' || message.status === 'provider_accepted')
    .map((message) => ({ message, at: message.receivedAt ?? message.providerAcceptedAt ?? message.createdAt ?? '' }))
    .filter((entry) => (Date.parse(entry.at) || 0) <= (Date.parse(parent.receivedAt ?? parent.createdAt ?? '') || Number.MAX_SAFE_INTEGER))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const kept = before.slice(-REPLY_AI_PREVIOUS_MAX_MESSAGES);
  const senderName = parent.fromName && parent.fromName.trim() && !parent.fromName.includes('@') ? parent.fromName.trim() : '';
  return {
    current: { senderName: minimizeForPrompt(senderName).slice(0, 120), subject: minimizeForPrompt(parent.subject ?? '').slice(0, 250), text: current.text, receivedAt: parent.receivedAt, truncated: current.truncated },
    previous: kept.map(({ message, at }) => ({
      direction: message.direction === 'inbound' ? 'inbound' : 'outbound',
      at,
      text: limit(minimizeForPrompt(stripQuotedHistory(message.bodyText ?? '')), REPLY_AI_PREVIOUS_MAX_CHARS).text,
    })),
    previousOmitted: before.length - kept.length,
    business: businessFacts(parent, deps),
    companyName: minimizeForPrompt(deps.companyName() ?? '').slice(0, 120),
  };
}
