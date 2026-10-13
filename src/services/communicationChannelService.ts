import type {
  CommunicationChannel,
  CommunicationContext,
  CommunicationDraft,
  CommunicationDraftCore,
} from '../types/communication';
import { getBusinessDay } from './businessDateService';
import { formatDisplayDatePadded } from '../utils/displayFormat';

function recipientLine(context: CommunicationContext, formal: boolean): string {
  const name = context.recipient?.name;
  if (!name || name === 'Sehr geehrte Damen und Herren') {
    return formal ? 'Sehr geehrte Damen und Herren,' : 'Guten Tag,';
  }
  return formal ? `Sehr geehrte/r ${name},` : `Hallo ${name.split(' ')[0] ?? name},`;
}

function closingLine(context: CommunicationContext, formal: boolean): string {
  if (formal) {
    return `Mit freundlichen Grüßen\n${context.companyName}`;
  }
  return `Viele Grüße\n${context.companyName}`;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N15) — der Briefschluss eines Entwurfs.
 *
 * Die Entwurfstexte (Erinnerung, Mahnung, Antwort …) enden bereits mit Grussformel und
 * Firma. Die Kanaldarstellung hängte trotzdem ihren eigenen Schluss an — in Mahnung und
 * Erinnerung stand „Mit freundlichen Grüßen" mit Firma zweimal; der Brief setzte zudem
 * eine zweite Anrede davor. Erkannt wird ein Schluss nur am Ende (Grussformel und höchstens
 * zwei Zeilen danach), wie beim Anhängen der E-Mail-Signatur (`appendSignatureOnce`).
 */
const CLOSING_LINE =
  /^(mit freundlichen(, vorzüglichen)? grüßen|freundliche grüße|viele grüße|beste grüße|herzliche grüße)\s*,?$/i;

export function splitTrailingClosing(body: string): { main: string; closing: string | null } {
  const lines = body.replace(/\s+$/, '').split('\n');
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 3); index -= 1) {
    if (CLOSING_LINE.test(lines[index].trim())) {
      return { main: lines.slice(0, index).join('\n').replace(/\s+$/, ''), closing: lines.slice(index).join('\n') };
    }
  }
  return { main: body.replace(/\s+$/, ''), closing: null };
}

const SALUTATION = /^Sehr geehrte|^Guten Tag|^Hallo/m;

function shortenBody(body: string): string {
  // WEISS N15 — der Schluss des Entwurfs fällt weg; die Kurzfassung bekommt ihren eigenen.
  const lines = splitTrailingClosing(body).main.split('\n').filter((line) => line.trim());
  const essential = lines.filter(
    (line) =>
      !line.startsWith('Mit freundlichen') &&
      !line.startsWith('Sehr geehrte') &&
      !line.startsWith('Guten Tag') &&
      !line.startsWith('Hallo'),
  );
  return essential.slice(0, 3).join('\n');
}

export function renderCommunicationDraft(
  coreDraft: CommunicationDraftCore,
  channel: CommunicationChannel,
  context: CommunicationContext,
): CommunicationDraft {
  if (channel === 'whatsapp') {
    const shortBody = shortenBody(coreDraft.body);
    return {
      ...coreDraft,
      channel,
      greeting: recipientLine(context, false),
      body: shortBody,
      closing: closingLine(context, false),
      tone: 'short',
    };
  }

  const hasGreeting = SALUTATION.test(coreDraft.body);
  // WEISS N15 — trägt der Entwurf seinen Schluss schon, kommt keiner hinzu.
  const ownClosing = splitTrailingClosing(coreDraft.body).closing;

  if (channel === 'email') {
    return {
      ...coreDraft,
      channel,
      subject: coreDraft.subject ?? context.subject ?? 'Nachricht',
      greeting: hasGreeting ? undefined : recipientLine(context, true),
      body: coreDraft.body,
      closing: ownClosing ? undefined : closingLine(context, true),
      tone: coreDraft.tone === 'short' ? 'neutral' : coreDraft.tone,
    };
  }

  /*
   * letter – formal. WEISS N15: Anrede und Schluss nur, wenn der Entwurf sie nicht schon
   * trägt; das Datum als Geschäftstag (Europe/Berlin) in deutscher Schreibweise statt des
   * UTC-Tages im ISO-Format.
   */
  const today = formatDisplayDatePadded(getBusinessDay());
  const letterBody = [
    context.companyName,
    today,
    '',
    ...(hasGreeting ? [] : [recipientLine(context, true), '']),
    coreDraft.body,
    ...(ownClosing ? [] : ['', closingLine(context, true)]),
  ].join('\n');

  return {
    ...coreDraft,
    channel,
    subject: coreDraft.subject,
    greeting: undefined,
    body: letterBody,
    closing: undefined,
    tone: 'formal',
  };
}

export function renderAllChannels(
  coreDraft: CommunicationDraftCore,
  context: CommunicationContext,
): Partial<Record<CommunicationChannel, CommunicationDraft>> {
  return {
    email: renderCommunicationDraft(coreDraft, 'email', context),
    whatsapp: renderCommunicationDraft(coreDraft, 'whatsapp', context),
    letter: renderCommunicationDraft(coreDraft, 'letter', context),
  };
}

export function getDraftBodyLength(draft: CommunicationDraft): number {
  return (draft.greeting?.length ?? 0) + draft.body.length + (draft.closing?.length ?? 0);
}
