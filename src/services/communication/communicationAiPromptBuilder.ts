import { buildAiLanguageInstruction } from '../ai/aiLanguageRules';
import { getCompanyProfile } from '../companyProfileService';
import { COMMUNICATION_AI_SYSTEM_RULES } from '../ai/aiGuardrails';
import type { CommunicationAiEnhanceInput, CommunicationAiEnhanceStyle } from '../../types/communicationAi';
import type { AppLanguage } from '../../types/models';
import type { CommunicationContext, CommunicationFact } from '../../types/communication';

const SENSITIVE_VALUE_PATTERNS = [
  /\bDE\d{2}\s?(?:\d{4}\s?){4}\d{2,4}\b/gi,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi,
  /\b\d{2,3}\/\d{3,5}\/\d{4,5}\b/g,
  /\bDE\d{9}\b/gi,
  /\bUSt[-\s]?Id\.?\s*Nr\.?\s*:?\s*DE\d{9}\b/gi,
  /\bSteuernummer\s*:?\s*[\d/]+\b/gi,
];

const STYLE_INSTRUCTIONS: Record<CommunicationAiEnhanceStyle, string> = {
  polite: 'Formuliere höflicher und respektvoller.',
  professional: 'Formuliere professioneller und sachlicher.',
  shorter: 'Kürze den Text, ohne Fakten zu entfernen.',
  longer: 'Formuliere etwas ausführlicher, aber ohne neue Fakten.',
  friendly: 'Formuliere freundlicher und zugänglicher.',
  assertive: 'Formuliere klarer und bestimmter, ohne neue Forderungen.',
};

function sanitizeSensitiveText(text: string): string {
  let sanitized = text;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[entfernt]');
  }
  return sanitized;
}

function isSensitiveFact(fact: CommunicationFact): boolean {
  const haystack = `${fact.key} ${fact.value}`.toLowerCase();
  return /iban|bic|steuernummer|ust|vat|bank/.test(haystack);
}

function formatContextFacts(context: CommunicationContext): string {
  const lines: string[] = [];

  if (context.recipient?.name) {
    lines.push(`Empfänger: ${context.recipient.name}`);
  }
  if (context.subject) {
    lines.push(`Betreff: ${sanitizeSensitiveText(context.subject)}`);
  }
  if (context.vorgangSummary) {
    lines.push(
      `Vorgang: ${context.vorgangSummary.title} (${context.vorgangSummary.customer})`,
    );
  }
  if (context.invoiceSummary) {
    lines.push(
      `Rechnung: ${context.invoiceSummary.number}, offen ${context.invoiceSummary.openAmount.toFixed(2)} €`,
    );
  }
  if (context.expenseSummary) {
    lines.push(
      `Ausgabe: ${context.expenseSummary.title}, offen ${context.expenseSummary.openAmount.toFixed(2)} €`,
    );
  }
  if (context.letterExplanation) {
    lines.push(`Briefinhalt: ${sanitizeSensitiveText(context.letterExplanation.about)}`);
    if (context.letterExplanation.deadline) {
      lines.push(`Frist: ${sanitizeSensitiveText(context.letterExplanation.deadline)}`);
    }
  }

  for (const fact of context.facts) {
    if (isSensitiveFact(fact)) continue;
    lines.push(`${fact.key}: ${sanitizeSensitiveText(fact.value)}`);
  }

  return lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : '- (keine zusätzlichen Fakten)';
}

function buildOriginalDraftBlock(input: CommunicationAiEnhanceInput): string {
  const { draft } = input;
  const parts = [
    `Intent: ${draft.intent}`,
    `Kanal: ${input.channel}`,
    draft.subject ? `Betreff: ${sanitizeSensitiveText(draft.subject)}` : undefined,
    draft.greeting ? `Anrede: ${sanitizeSensitiveText(draft.greeting)}` : undefined,
    `Haupttext:\n${sanitizeSensitiveText(draft.body)}`,
    draft.closing ? `Grußformel: ${sanitizeSensitiveText(draft.closing)}` : undefined,
    `Basierend auf:\n${draft.basedOnFacts.map((fact) => `- ${sanitizeSensitiveText(fact)}`).join('\n')}`,
    `Nicht enthalten:\n${draft.notIncluded.map((item) => `- ${sanitizeSensitiveText(item)}`).join('\n')}`,
  ].filter(Boolean);

  return parts.join('\n\n');
}

export function buildCommunicationAiPrompt(
  input: CommunicationAiEnhanceInput,
  lang: AppLanguage = 'de',
): string {
  const profile = getCompanyProfile();
  const companyLine = [
    profile.companyName,
    profile.contactPerson,
    profile.city,
  ]
    .filter(Boolean)
    .join(' | ');

  return `${COMMUNICATION_AI_SYSTEM_RULES}

${buildAiLanguageInstruction(lang)}

FIRMA (ohne Bank-/Steuerdaten):
${sanitizeSensitiveText(companyLine || '—')}

KONTEXT-FAKTEN:
${formatContextFacts(input.context)}

ORIGINAL-ENTWURF:
${buildOriginalDraftBlock(input)}

STIL-AUFTRAG:
${STYLE_INSTRUCTIONS[input.style]}

Gib nur den verbesserten Haupttext zurück – ohne Betreff, ohne Anrede, ohne Grußformel.
Keine Erklärungen, keine Markdown-Formatierung.`;
}

export function buildCommunicationAiAllowedSourceText(input: CommunicationAiEnhanceInput): string {
  const profile = getCompanyProfile();
  return [
    input.draft.body,
    input.draft.subject ?? '',
    input.draft.greeting ?? '',
    input.draft.closing ?? '',
    ...input.draft.basedOnFacts,
    ...input.context.facts.map((fact) => fact.value),
    input.context.invoiceSummary
      ? `${input.context.invoiceSummary.openAmount} ${input.context.invoiceSummary.amount}`
      : '',
    input.context.expenseSummary
      ? `${input.context.expenseSummary.openAmount} ${input.context.expenseSummary.grossAmount}`
      : '',
    input.context.letterExplanation?.deadline ?? '',
    input.context.letterExplanation?.about ?? '',
    profile.taxNumber,
    profile.vatId,
    profile.iban,
  ].join('\n');
}
