/**
 * E-MAIL 07F-01C — Antwortentwurf vorbereiten (nie senden).
 *
 * Kontext (emailReplyAiContext) → Prompt (emailReplyAiPromptBuilder) →
 * bestehender `runAiRequest` mit der Operation `communication_draft` und dem
 * Ausgabe-Guard `reply`. Kein direkter Provider-Aufruf, keine neue
 * Providerintegration, kein Wiederholungsversuch (jeder Versuch kostet Geld).
 *
 * Zurück kommt ausschließlich der vorbereitete Antworttext und die darin
 * gesetzten Platzhalter. Empfänger, Betreff, Kunde/Vorgang, Verlauf und
 * Versand bleiben vollständig bei der deterministischen E-Mail-Logik.
 */
import type { EmailMessage } from '../../types/emailMessage';
import type { AppLanguage } from '../../types/models';
import { runAiRequest } from '../ai/aiRequestRunner';
import { getCachedSetup } from '../persistenceService';
import { getCompanyProfile } from '../companyProfileService';
import { getCustomerById } from '../customerStoreService';
import { getVorgangById } from '../vorgangService';
import { calculatePaymentSummary } from '../invoicePaymentService';
import { assessReplySuitability, buildEmailReplyAiContext, type EmailReplyAiContextDeps } from './emailReplyAiContext';
import { buildEmailReplyAiPrompt, buildReplyAllowedSourceText, findReplyPlaceholders } from './emailReplyAiPromptBuilder';

export type EmailReplyDraftError =
  | 'unsuitable_empty'
  | 'unsuitable_short'
  | 'unsuitable_automated'
  | 'unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'provider'
  | 'guard_rejected';

export type EmailReplyDraftResult =
  | { ok: true; body: string; placeholders: string[] }
  | { ok: false; error: EmailReplyDraftError };

export const defaultReplyContextDeps: EmailReplyAiContextDeps = {
  getCustomer: (id) => getCustomerById(id),
  getVorgang: (id) => getVorgangById(id),
  openAmount: (invoice) => {
    try {
      return calculatePaymentSummary(invoice).openAmount;
    } catch {
      return undefined;
    }
  },
  companyName: () => getCompanyProfile().companyName ?? '',
};

/* ------------------------------------------------------------------------ */
/* Einsetzen in den bestehenden Antwort-Entwurf (reine Funktionen)           */
/* ------------------------------------------------------------------------ */

/** Position des deterministischen Schlusses (Signatur + Zitat) im Text; -1, wenn der Nutzer ihn verändert hat. */
function tailIndex(body: string, tail: string | undefined): number {
  const trimmed = (tail ?? '').trim();
  return trimmed ? body.lastIndexOf(trimmed) : -1;
}

/** Eigener Text des Nutzers vor Signatur/Zitat — `null`, wenn der Schluss nicht mehr erkennbar ist. */
export function replyUserPart(body: string, tail: string | undefined): string | null {
  const index = tailIndex(body, tail);
  return index >= 0 ? body.slice(0, index).trim() : null;
}

/**
 * KI-Text VOR Signatur und Zitat einsetzen. Ein vorheriger KI-Text bzw. der
 * Text an dieser Stelle wird ersetzt (Bestätigung vorher, siehe
 * `replyWouldOverwriteManualText`); Signatur und Zitat bleiben genau einmal.
 * Ist der Schluss nicht mehr erkennbar, wird nur vorangestellt — nichts geht verloren.
 */
export function composeReplyBody(body: string, aiText: string, tail: string | undefined, previousAi?: string): string {
  const text = aiText.trim();
  const index = tailIndex(body, tail);
  if (index >= 0) return `${text}\n\n${body.slice(index)}`;
  let rest = body.replace(/^\s+/, '');
  const previous = (previousAi ?? '').trim();
  if (previous && rest.startsWith(previous)) rest = rest.slice(previous.length).replace(/^\s+/, '');
  return rest ? `${text}\n\n${rest}` : text;
}

/** Würde „Neu vorbereiten" eigenen (manuell geänderten) Text ersetzen? */
export function replyWouldOverwriteManualText(body: string, tail: string | undefined, previousAi?: string): boolean {
  const user = replyUserPart(body, tail);
  if (user === null) return false;
  return user !== '' && user !== (previousAi ?? '').trim();
}

/** Platzhalter nur im eigenen Antworttext (nicht im Zitat der Originalmail). */
export function replyPlaceholdersIn(body: string, tail: string | undefined): string[] {
  const user = replyUserPart(body, tail);
  const own = user ?? body.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  return findReplyPlaceholders(own);
}

export async function prepareEmailReplyDraft(
  input: { parent: EmailMessage; thread: EmailMessage[]; language?: AppLanguage },
  deps: EmailReplyAiContextDeps = defaultReplyContextDeps,
): Promise<EmailReplyDraftResult> {
  const suitability = assessReplySuitability(input.parent);
  if (suitability === 'empty') return { ok: false, error: 'unsuitable_empty' };
  if (suitability === 'too_short') return { ok: false, error: 'unsuitable_short' };
  if (suitability === 'automated') return { ok: false, error: 'unsuitable_automated' };

  const language = input.language ?? getCachedSetup()?.language ?? 'de';
  const context = buildEmailReplyAiContext(input.parent, input.thread, deps);
  const allowedSourceText = buildReplyAllowedSourceText(context);
  const result = await runAiRequest({
    operation: 'communication_draft',
    prompt: buildEmailReplyAiPrompt(context, language),
    guardProfile: 'reply',
    guardContext: { originalText: context.current.text, allowedSourceText },
  });

  if (result.source === 'unavailable') return { ok: false, error: 'unavailable' };
  if (!result.success || !result.text) {
    if (result.errorCode === 'guard_rejected') return { ok: false, error: 'guard_rejected' };
    if (result.errorCode === 'rate_limited') return { ok: false, error: 'rate_limited' };
    if (result.errorCode === 'ai_timeout') return { ok: false, error: 'timeout' };
    return { ok: false, error: 'provider' };
  }
  const body = result.text.trim();
  if (!body) return { ok: false, error: 'guard_rejected' };
  return { ok: true, body, placeholders: findReplyPlaceholders(body) };
}
