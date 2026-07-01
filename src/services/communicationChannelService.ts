import type {
  CommunicationChannel,
  CommunicationContext,
  CommunicationDraft,
  CommunicationDraftCore,
} from '../types/communication';

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

function shortenBody(body: string): string {
  const lines = body.split('\n').filter((line) => line.trim());
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

  if (channel === 'email') {
    const hasGreeting = /^Sehr geehrte|^Guten Tag|^Hallo/m.test(coreDraft.body);
    return {
      ...coreDraft,
      channel,
      subject: coreDraft.subject ?? context.subject ?? 'Nachricht',
      greeting: hasGreeting ? undefined : recipientLine(context, true),
      body: coreDraft.body,
      closing: closingLine(context, true),
      tone: coreDraft.tone === 'short' ? 'neutral' : coreDraft.tone,
    };
  }

  // letter – formal
  const today = new Date().toISOString().slice(0, 10);
  const letterBody = [
    context.companyName,
    today,
    '',
    recipientLine(context, true),
    '',
    coreDraft.body,
    '',
    closingLine(context, true),
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
