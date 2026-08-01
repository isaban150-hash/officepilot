import { amountsClose, parseAmountNumber } from '../../document-cases/_lib/normalize';
import { getDocumentById } from '../../../services/documentService';
import type { InvoiceJourneyObservation } from './runInvoiceJourney';

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

/** Structured fields only — not raw OCR dump (_extractedText). */
function structuredFieldBlob(obs: InvoiceJourneyObservation): string {
  const { inbox, expense, pipeline } = obs;
  const rd = inbox.recognizedData ?? {};
  const du = pipeline.workflow.documentUnderstanding;
  return [
    inbox.sender,
    inbox.deadline,
    rd.Lieferant,
    rd.Absender,
    rd.Rechnungsnummer,
    rd.Betrag,
    rd.Datum,
    rd.Frist,
    rd['Fälligkeit'],
    du?.sender,
    du?.invoiceNumber,
    du?.amount,
    du?.date,
    du?.deadline,
    expense.supplierName,
    expense.invoiceNumber,
    expense.issueDate,
    expense.paymentDueDate,
    String(expense.grossAmount),
  ]
    .filter(Boolean)
    .join(' | ');
}

/**
 * Fachliche Fakten nach ER-Journey (Klassifikation, Felder, Archiv, Ausgabe).
 */
export function assertInvoiceJourney(obs: InvoiceJourneyObservation): void {
  const { reference, pipeline, inbox, archiveDocumentId, expense } = obs;
  const exp = reference.invoiceJourney;
  const caseId = reference.caseId;
  const blob = structuredFieldBlob(obs);

  const kind =
    pipeline.workflow.classifiedKind ??
    inbox.classifiedKind ??
    inbox.recognizedData.Dokumentart ??
    '';
  if (!exp.classifiedKindAllowed.includes(kind)) {
    fail(
      caseId,
      'Dokument falsch klassifiziert / Rechnung in falscher Akte',
      `kind="${kind}", allowed=${exp.classifiedKindAllowed.join(',')}`,
    );
  }

  if (!blob.toLowerCase().includes(exp.supplierContains.toLowerCase())) {
    fail(caseId, 'falscher Lieferant', `erwartet enthält "${exp.supplierContains}"`);
  }

  if (!blob.includes(exp.invoiceNumber)) {
    fail(caseId, 'verlorene Rechnungsnummer', `fehlt "${exp.invoiceNumber}"`);
  }

  const issueOk =
    blob.includes(exp.issueDateContains) ||
    (() => {
      const german = exp.issueDateContains.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!german) return false;
      return blob.includes(`${german[3]}-${german[2]}-${german[1]}`);
    })();
  if (!issueOk) {
    fail(caseId, 'verlorenes Rechnungsdatum', `fehlt "${exp.issueDateContains}"`);
  }

  const amountCandidates = [
    expense.grossAmount,
    parseAmountNumber(pipeline.workflow.documentUnderstanding?.amount),
    parseAmountNumber(inbox.recognizedData.Betrag),
  ].filter((n): n is number => n != null && Number.isFinite(n));

  if (!amountCandidates.some((n) => amountsClose(n, exp.amountApprox))) {
    fail(
      caseId,
      'falscher Betrag',
      `erwartet ~${exp.amountApprox}, got ${JSON.stringify(amountCandidates)}`,
    );
  }

  if (exp.dueDateContains) {
    const dueBlob = [
      inbox.deadline,
      inbox.recognizedData.Frist,
      pipeline.workflow.documentUnderstanding?.deadline,
      expense.paymentDueDate,
    ]
      .filter(Boolean)
      .join(' | ');
    const dueOk =
      dueBlob.includes(exp.dueDateContains) ||
      (() => {
        const german = exp.dueDateContains.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (!german) return false;
        return dueBlob.includes(`${german[3]}-${german[2]}-${german[1]}`);
      })();
    if (!dueOk) {
      fail(caseId, 'verlorenes Fälligkeitsdatum', `fehlt "${exp.dueDateContains}" in ${dueBlob}`);
    }
  }

  if (exp.requireArchive) {
    const archived = getDocumentById(archiveDocumentId);
    if (!archived) {
      fail(caseId, 'Rechnung nicht archiviert', 'Archivdokument fehlt');
    }
    if (inbox.archiveDocumentId !== archiveDocumentId) {
      fail(caseId, 'Rechnung nicht archiviert', 'Inbox.archiveDocumentId inkonsistent');
    }
  }

  if (exp.requireExpense) {
    if (!expense?.id) {
      fail(caseId, 'fehlende Verknüpfung / Ausgabe fehlt', 'expense fehlt');
    }
  }

  if (exp.requireExpenseLinkedInbox && expense.linkedInboxId !== inbox.id) {
    fail(
      caseId,
      'fehlende Verknüpfung',
      `linkedInboxId=${expense.linkedInboxId}`,
    );
  }

  if (exp.requireArchiveOnExpense && expense.archiveDocumentId !== archiveDocumentId) {
    fail(
      caseId,
      'fehlende Verknüpfung Archiv ↔ Ausgabe',
      `expense.archiveDocumentId=${expense.archiveDocumentId}`,
    );
  }

  if (expense.paymentStatus !== exp.expectedPaymentStatus) {
    fail(
      caseId,
      'Zahlungsstatus falsch',
      `expected ${exp.expectedPaymentStatus}, got ${expense.paymentStatus}`,
    );
  }

  // Keine Vertrags-/LV-Wirkung auf Eingangsrechnung.
  const positions =
    pipeline.workflow.contractOrderProposal?.positions ??
    pipeline.workflow.suggestedOrderPositions ??
    [];
  if (positions.length > 0) {
    fail(
      caseId,
      'Rechnung in falscher Akte / Vertragswirkung',
      `unerwartete Positionen: ${positions.length}`,
    );
  }
}
