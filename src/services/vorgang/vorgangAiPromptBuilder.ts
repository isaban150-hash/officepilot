import { buildAiLanguageInstruction } from '../ai/aiLanguageRules';
import type { AppLanguage } from '../../types/models';
import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';
import { getCompanyProfile } from '../companyProfileService';
import { sanitizeAiText } from '../ai/aiTextSanitizer';
import type { VorgangAiContext } from '../../types/areaAi';

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatSection(title: string, lines: string[]): string {
  if (lines.length === 0) return `${title}:\n- (keine Einträge)`;
  return `${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

export function buildVorgangAiPrompt(
  question: string,
  context: VorgangAiContext,
  lang: AppLanguage = 'de',
): string {
  const profile = getCompanyProfile();
  const companyLine = sanitizeAiText(
    [profile.companyName, profile.contactPerson, profile.city].filter(Boolean).join(' | '),
  );

  return `${AI_QA_SYSTEM_RULES}

${buildAiLanguageInstruction(lang)}

FIRMA (ohne Bank-/Steuerdaten):
${companyLine || '—'}

VORGANG-KONTEXT:
Titel: ${context.title}
Kunde: ${context.customer}
Baustelle: ${context.baustelle}
Status: ${context.status}
Offene Rechnungssumme gesamt: ${formatEuro(context.openInvoiceTotal)}

${formatSection(
  'Notizen',
  context.notes.map((note) => `${note.occurredAt}: ${note.body}`),
)}

${formatSection(
  'Offene Aufgaben',
  context.openTasks.map((task) =>
    task.dueDate ? `${task.title} (Frist: ${task.dueDate})` : task.title,
  ),
)}

${formatSection(
  'Rechnungen',
  context.invoices.map(
    (invoice) =>
      `${invoice.number} · offen ${formatEuro(invoice.openAmount)} (${invoice.paymentStatus})${
        invoice.dueDate ? ` · Fällig: ${invoice.dueDate}` : ''
      }`,
  ),
)}

${formatSection(
  'Verknüpfte Dokumente',
  context.linkedDocuments.map((doc) => `${doc.title} (${doc.category})`),
)}

NUTZERFRAGE:
${question}

Antworte in 2–6 Sätzen oder einer kurzen Aufzählung. Wenn Informationen fehlen, sage das explizit.`;
}
