import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';
import type { BrainSnapshot } from '../../types/brain';
import { BRAIN_ANSWER_DISCLAIMER } from '../../types/brain';
import type { CompanySessionContext } from '../../types/companySession';
import { buildSessionContextBlock } from './companySessionService';
import { buildHandwerkGlossaryBlock } from './handwerkKnowledgeRegistry';

export { BRAIN_ANSWER_DISCLAIMER };

const BRAIN_SYSTEM_RULES = AI_QA_SYSTEM_RULES;

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatSection(title: string, lines: string[]): string {
  if (lines.length === 0) return `${title}:\n- (keine Einträge)`;
  return `${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

export function buildBrainContextBlock(snapshot: BrainSnapshot): string {
  const sections: string[] = [
    `Stichtag: ${snapshot.referenceDate}`,
    `Firma: ${snapshot.company.companyName || '—'} | Ansprechpartner: ${snapshot.company.contactPerson || '—'} | ${snapshot.company.zip} ${snapshot.company.city}`,
    formatSection(
      'Vorgänge',
      snapshot.vorgaenge.map(
        (v) => `${v.title} (${v.customer}, Status: ${v.status}, Rechnungen: ${v.invoiceCount})`,
      ),
    ),
    `Rechnungen gesamt: offen ${snapshot.invoiceTotals.openInvoiceCount}, überfällig ${snapshot.invoiceTotals.overdueInvoiceCount}, offene Summe ${formatEuro(snapshot.invoiceTotals.openReceivables)}`,
    formatSection(
      'Offene Rechnungen',
      snapshot.invoices.map(
        (inv) =>
          `${inv.number} · ${inv.customer} · offen ${formatEuro(inv.openAmount)} (${inv.paymentStatus})`,
      ),
    ),
    `Ausgaben offen: ${snapshot.expenseOpenCount}`,
    formatSection(
      'Offene Ausgaben',
      snapshot.expenses.map(
        (exp) => `${exp.title} · ${exp.supplierName} · offen ${formatEuro(exp.openAmount)}`,
      ),
    ),
    formatSection(
      'Offene Aufgaben',
      snapshot.tasksOpen.map((task) =>
        task.dueDate ? `${task.title} (Frist: ${task.dueDate})` : task.title,
      ),
    ),
    formatSection(
      'Aufgaben heute',
      snapshot.tasksToday.map((task) => task.title),
    ),
    formatSection(
      'Dokumente',
      snapshot.documents.map((doc) => `${doc.title} (${doc.category})`),
    ),
    formatSection(
      'Eingang',
      snapshot.inbox.map((item) => `${item.title} von ${item.sender} (${item.status})`),
    ),
    formatSection(
      'Wissen',
      snapshot.knowledge.map((fact) => `[${fact.scope}] ${fact.displayText}`),
    ),
    formatSection(
      'Vorgangsnotizen',
      snapshot.notes.map((note) => `${note.vorgangTitle}: ${note.body}`),
    ),
    formatSection(
      'Kommunikationshistorie',
      snapshot.communicationHistory.map(
        (event) => `${event.type}${event.channel ? ` (${event.channel})` : ''}: ${event.excerpt}`,
      ),
    ),
  ];

  return sections.join('\n\n');
}

export function buildBrainPrompt(
  question: string,
  snapshot: BrainSnapshot,
  session?: CompanySessionContext,
): string {
  const sessionBlock = session ? `\n\n${buildSessionContextBlock(session)}` : '';
  const handwerkBlock = `\n\n${buildHandwerkGlossaryBlock()}`;
  return `${BRAIN_SYSTEM_RULES}

OFFICEPILOT-DATEN:
${buildBrainContextBlock(snapshot)}${sessionBlock}${handwerkBlock}

NUTZERFRAGE:
${question}

Antworte in 2–6 Sätzen oder einer kurzen Aufzählung. Wenn Informationen fehlen, sage das explizit. Nutze den Gesprächskontext für Folgefragen, wenn vorhanden.`;
}
