import { buildAiLanguageInstruction } from '../ai/aiLanguageRules';
import type { AppLanguage } from '../../types/models';
import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';
import { getCompanyProfile } from '../companyProfileService';
import { sanitizeAiText } from '../ai/aiTextSanitizer';
import type { DocumentAiContext } from '../../types/areaAi';

function formatSection(title: string, lines: string[]): string {
  if (lines.length === 0) return `${title}:\n- (keine Angaben)`;
  return `${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

export function buildDocumentAiPrompt(
  question: string,
  context: DocumentAiContext,
  lang: AppLanguage = 'de',
): string {
  const profile = getCompanyProfile();
  const companyLine = sanitizeAiText(
    [profile.companyName, profile.contactPerson, profile.city].filter(Boolean).join(' | '),
  );

  const sections = [
    `Quelle: ${context.sourceType === 'inbox' ? 'Eingangsschreiben' : 'Archivdokument'}`,
    `Titel: ${sanitizeAiText(context.title)}`,
    `Aussteller/Sender: ${sanitizeAiText(context.issuerOrSender)}`,
    `Kategorie: ${sanitizeAiText(context.category)}`,
    context.deadline ? `Frist: ${sanitizeAiText(context.deadline)}` : undefined,
    context.validUntil ? `Gültig bis: ${sanitizeAiText(context.validUntil)}` : undefined,
    context.issueDate ? `Ausstellungsdatum: ${sanitizeAiText(context.issueDate)}` : undefined,
    context.linkedVorgangTitle
      ? `Verknüpfter Vorgang: ${sanitizeAiText(context.linkedVorgangTitle)}`
      : undefined,
    context.letterSummary
      ? formatSection('Brief-Zusammenfassung', [
          `Inhalt: ${context.letterSummary.about}`,
          `Frist: ${context.letterSummary.deadline}`,
          `Nächste Schritte: ${context.letterSummary.nextSteps}`,
        ])
      : undefined,
    formatSection('Erkannte Daten', context.recognizedDataLines),
    context.recognizedText
      ? `Erkannter Text (Auszug):\n${context.recognizedText}`
      : undefined,
    formatSection('Fehlende Unterlagen', context.missingDocuments),
  ].filter(Boolean);

  return `${AI_QA_SYSTEM_RULES}

${buildAiLanguageInstruction(lang)}

FIRMA (ohne Bank-/Steuerdaten):
${companyLine || '—'}

DOKUMENT-KONTEXT:
${sections.join('\n\n')}

NUTZERFRAGE:
${question}

Antworte in 2–6 Sätzen oder einer kurzen Aufzählung. Wenn Informationen fehlen, sage das explizit.`;
}
