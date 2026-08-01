import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DocumentIntakeUnderstandingPanel } from '../../../components/inbox/DocumentIntakeUnderstandingPanel';
import { ExpenseOverviewCard } from '../../../components/expenses/ExpenseOverviewCard';
import { t, type TranslationKey } from '../../../i18n';
import {
  calculateExpensePaymentSummary,
  formatPaymentCurrency,
} from '../../../services/expensePaymentService';
import type { InvoiceJourneyObservation } from './runInvoiceJourney';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

/** Accept German DD.MM.YYYY / D.M.YYYY or ISO YYYY-MM-DD for the same calendar day. */
function dateVisibleInHtml(html: string, dateContains: string): boolean {
  if (html.includes(dateContains)) return true;
  const german = dateContains.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (german) {
    const day = Number(german[1]);
    const month = Number(german[2]);
    const year = german[3]!;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (html.includes(iso)) return true;
    // toLocaleDateString('de-DE') often omits leading zeros
    if (html.includes(`${day}.${month}.${year}`)) return true;
    if (html.includes(`${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`)) {
      return true;
    }
  }
  const iso = dateContains.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = iso[1]!;
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (html.includes(`${day}.${month}.${year}`)) return true;
    if (html.includes(`${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`)) {
      return true;
    }
  }
  return false;
}

/**
 * UI-Fakten: Intake-Understanding + Ausgabe-Übersichtskarte.
 */
export function assertInvoiceUiVisibility(obs: InvoiceJourneyObservation): void {
  const { reference, pipeline, expense, archiveDocumentId } = obs;
  const exp = reference.invoiceUiVisibility;
  const journey = reference.invoiceJourney;
  const caseId = reference.caseId;

  const understanding = pipeline.workflow.documentUnderstanding;
  if (!understanding) {
    fail(caseId, 'Rechnung nicht sichtbar', 'documentUnderstanding fehlt');
  }

  const understandingHtml = renderToStaticMarkup(
    createElement(DocumentIntakeUnderstandingPanel, {
      summary: understanding,
      translate,
    }),
  );

  if (exp.understandingPanelVisible) {
    if (!understandingHtml.includes('data-testid="document-intake-understanding"')) {
      fail(caseId, 'Rechnung nicht sichtbar', 'Understanding-Panel fehlt');
    }
  }

  if (exp.supplierVisible) {
    if (!understandingHtml.includes(journey.supplierContains)) {
      fail(caseId, 'falscher Lieferant', 'Lieferant/Absender nicht im Understanding-UI');
    }
  }

  if (exp.invoiceNumberVisible) {
    if (!understandingHtml.includes(journey.invoiceNumber)) {
      fail(caseId, 'verlorene Rechnungsnummer', 'Rechnungsnummer nicht im Understanding-UI');
    }
  }

  const overviewItem = {
    expense,
    paymentSummary: calculateExpensePaymentSummary(expense),
  };

  const expenseHtml = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ExpenseOverviewCard, {
        item: overviewItem,
        translate,
      }),
    ),
  );

  const combinedHtml = `${understandingHtml}\n${expenseHtml}`;

  if (exp.issueDateVisible) {
    if (!dateVisibleInHtml(combinedHtml, journey.issueDateContains)) {
      fail(
        caseId,
        'verlorenes Rechnungsdatum',
        `Datum nicht in Understanding/Expense-UI (du.date=${understanding.date ?? '—'}, expense.issueDate=${expense.issueDate})`,
      );
    }
  }

  if (exp.amountVisible) {
    const formatted = formatPaymentCurrency(expense.grossAmount);
    const amountOk =
      combinedHtml.includes('1.475,60') ||
      combinedHtml.includes('1475,60') ||
      combinedHtml.includes(formatted) ||
      combinedHtml.includes('1.475');
    if (!amountOk) {
      fail(caseId, 'falscher Betrag', 'Betrag nicht in Understanding/Expense-UI');
    }
  }

  if (exp.dueDateVisible && journey.dueDateContains) {
    if (!dateVisibleInHtml(combinedHtml, journey.dueDateContains)) {
      fail(
        caseId,
        'verlorenes Fälligkeitsdatum',
        `Frist nicht in Understanding/Expense-UI (du.deadline=${understanding.deadline ?? '—'})`,
      );
    }
  }

  if (exp.expenseCardVisible) {
    if (!expenseHtml.includes(expense.supplierName) && !expenseHtml.includes(journey.supplierContains)) {
      fail(caseId, 'falscher Lieferant', 'Lieferant nicht in ExpenseOverviewCard');
    }
    if (!expenseHtml.includes(journey.invoiceNumber)) {
      fail(caseId, 'verlorene Rechnungsnummer', 'Rechnungsnummer nicht in Expense-UI');
    }
  }

  if (exp.paymentStatusVisible) {
    const statusLabel = translate(`payment.status.${journey.expectedPaymentStatus}`);
    if (!expenseHtml.includes(statusLabel) && !expenseHtml.includes('payment.paymentStatus')) {
      fail(caseId, 'Zahlungsstatus falsch', `Status "${statusLabel}" nicht sichtbar`);
    }
  }

  if (exp.archiveLinkVisible) {
    if (!expense.archiveDocumentId || expense.archiveDocumentId !== archiveDocumentId) {
      fail(caseId, 'Rechnung nicht archiviert', 'archiveDocumentId an Ausgabe fehlt');
    }
    const archiveLabel = translate('expenseOverview.archive');
    if (!expenseHtml.includes(archiveLabel) && !expenseHtml.includes(`/dokumente/${archiveDocumentId}`)) {
      fail(caseId, 'fehlende Verknüpfung', 'Archiv-Link nicht in Expense-UI');
    }
  }
}
