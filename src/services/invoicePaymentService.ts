import { fromCents, sumCents, toCents } from './invoiceMoney';
import {
  addPaymentToInvoice,
  getVorgangInvoice,
  moveInvoicePayments,
  removePaymentFromInvoice,
  replaceInvoicePayments,
} from './vorgangService';
import { isFinalizedInvoice } from './invoiceArchiveService';
import { getSkontoFristStatus } from './invoice/skontoSettlement';
import { getBusinessDay, toBusinessDay } from './businessDateService';
import { nachFristende, zahlungszielFenster } from './fristen/fristende';
import { generateUuid } from './sync/syncMetaService';
import { clearInvoicePaymentUnconfirmed, markInvoicePaymentUnconfirmed } from './invoice/invoicePaymentConfirmationStore';
import { listInvoiceEntries } from './invoice/invoiceRegistryService';
import { reconcileInvoicePaymentTasks } from './invoice/invoicePaymentTaskSync';
import {
  findFinalInvoiceBlockingPaymentReversal,
  hasFrozenFinalInvoiceDeduction,
} from './invoice/invoiceCancelEligibility';
import { resolveWorkspaceWriteAccess, type WorkspaceActor } from './workspace/workspaceRoleService';
import { normalizePaymentMethod } from '../types/models';
import {
  calculateOverpaidAmount,
  getPaymentOverpayAmount as getPaymentOverpayAmountShared,
  isSettledPaymentStatus,
  requiresOverpaymentConfirmation,
  resolveSettlementStatus,
} from './payment/paymentSemantics';
import type { InvoicePaymentCloudOutcome } from './invoice/workspaceInvoicePaymentCloudService';
import type {
  InvoicePayment,
  InvoicePaymentInput,
  InvoicePaymentStatus,
  PaymentSummary,
  RejectedInvoicePayment,
  RejectedInvoicePaymentReason,
  VorgangInvoice,
} from '../types/models';

export type PaymentMutationResult =
  | { success: true; invoice: VorgangInvoice; payment: InvoicePayment }
  | { success: false; errorKey: string };

export type RemovePaymentResult =
  | { success: true; invoice: VorgangInvoice }
  | { success: false; errorKey: string };

/*
 * FINANZ-CORE-01A (ZAH-16) — Fälligkeit und Fristen zählen nach dem
 * Geschäftstag, nicht nach dem UTC-Tag. `toISOString` lag zwischen lokaler
 * Mitternacht und UTC-Mitternacht einen Tag zurück: Eine am 10. fällige
 * Rechnung galt am 11. um 0:30 Uhr noch nicht als überfällig. Ein reines
 * Datum bleibt unverändert; nur ein Zeitstempel wird in den Ortstag gelesen.
 */
function toDateOnly(value: Date | string): string {
  if (typeof value !== 'string') return getBusinessDay(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value.trim()) ? toBusinessDay(value) : value.slice(0, 10);
}

export function getInvoicePayments(invoice: VorgangInvoice): InvoicePayment[] {
  return (invoice.payments ?? []).map((payment) => ({ ...payment }));
}

export function getPaidAmount(invoice: VorgangInvoice): number {
  // FINANZ-CORE-01A — in Cent summiert: 10,10 + 20,20 ergibt genau 30,30.
  return fromCents(sumCents(getInvoicePayments(invoice).map((payment) => toCents(payment.amount))));
}

/**
 * INVOICE-SKONTO-PAYMENT-RECONCILIATION-01 — der Betrag, der die Rechnung
 * tatsächlich ausgleicht.
 *
 * Ein gewährtes Skonto ist ein zulässiger Nachlass, keine Restforderung. Zahlt
 * der Kunde fristgerecht den verminderten Betrag, ist die Rechnung erledigt —
 * bis hierher blieb die Differenz als offener Posten stehen und machte die
 * Rechnung sogar überfällig, mit Mahnfolge.
 *
 * Drei Grenzen, die bewusst eng bleiben:
 *
 *  1. **Frist am Zahlungsdatum**, nicht am heutigen Tag. Eine fristgerechte
 *     Zahlung bleibt fristgerecht, auch wenn sie erst später betrachtet wird;
 *     eine verspätete wird durch Zeitablauf nicht nachträglich gültig.
 *  2. **Nur der volle Skontobetrag heilt.** Wer weniger zahlt, hat weiterhin
 *     eine Unterzahlung — Skonto ist kein Freibrief für einen beliebigen Abzug.
 *  3. **Nichts wird geraten.** Ohne belastbaren Prozentsatz und Frist aus dem
 *     Skontosatz der Rechnung gibt es kein Skonto; ohne Basisdatum keine Frist.
 *
 * Basis ist `invoice.amount`, also der Rechnungsbetrag nach Abzügen — dieselbe
 * Basis, die `financeIntelligenceService` seinem Skontohinweis zugrunde legt.
 * Der Rundungsspielraum von einem Cent fängt nur die Multiplikation ab.
 */
// FINANZ-CORE-01A (Feiertage) — der Skonto-Fristenstatus wohnt im nur lesenden Skontomodul (der Bankabgleich
// importiert keinen Zahlungsdienst, BANKABGLEICH-04 D2); hier unverändert weitergereicht.
export { getSkontoFristStatus, type SkontoFristStatus } from './invoice/skontoSettlement';

export function getOpenAmount(invoice: VorgangInvoice): number {
  /*
   * INVOICE-CANCELLED-OPEN-AMOUNT-01B — der Storno hat Vorrang vor jeder
   * Betragsrechnung.
   *
   * Eine stornierte Rechnung ist keine Forderung mehr. Bis hierher rechnete
   * diese Funktion stur `amount - paid` weiter, und weil **alle** Anzeigen der
   * offenen Forderung über sie laufen, behauptete der Vorgang neben einer
   * wirksamen Ersatzrechnung eine zweite, längst stornierte Forderung.
   *
   * Bewusst genau hier und nicht im Aggregat: Es soll **eine** Wahrheit für
   * „offen" geben. Eine zweite Stornoregel in der Summenbildung könnte von
   * dieser abweichen — und der Widerspruch fiele erst wieder einem Nutzer auf.
   *
   * Dieselbe Quelle, die `resolvePaymentStatus` längst benutzt; keine neue
   * fachliche Regel. Die Geschichte bleibt unberührt: `invoice.amount`,
   * `totalDue` und `getPaidAmount` ändern sich nicht — bereits geflossenes
   * Geld bleibt sichtbar, nur der Forderungscharakter entfällt.
   */
  if (isInvoiceCancelled(invoice)) return 0;

  const paidCents = toCents(getPaidAmount(invoice));
  const dueCents = toCents(invoice.amount);
  if (paidCents < dueCents && getSkontoFristStatus(invoice).status === 'beglichen') {
    return 0;
  }
  return fromCents(Math.max(0, dueCents - paidCents));
}

export function isInvoiceCancelled(invoice: VorgangInvoice): boolean {
  return invoice.paymentStatus === 'storniert' || Boolean(invoice.cancelledAt);
}

/** Workflow status: invoice was marked as handed to the customer. */
export function isSentInvoice(invoice: VorgangInvoice): boolean {
  return invoice.status === 'versendet';
}

/**
 * Payment is expected only after the invoice was marked as sent.
 * Prepared (vorbereitet) invoices stay visible in open receivables but are not due/dunning.
 */
export function isExpectingPayment(invoice: VorgangInvoice): boolean {
  return isSentInvoice(invoice) && !isInvoiceCancelled(invoice);
}

export function isInvoiceOverdue(invoice: VorgangInvoice, today: Date | string = new Date()): boolean {
  // Overdue / dunning only for invoices marked as sent to the customer.
  if (!isExpectingPayment(invoice)) {
    return false;
  }
  if (!invoice.paymentDueDate || getOpenAmount(invoice) <= 0) {
    return false;
  }

  /*
   * FINANZ-CORE-01A (Feiertage) — ein Rest, der nur an einer ungeklärten Skontofrist hängt, ist nicht
   * fällig: Ob er geschuldet ist, steht erst fest, wenn der Ort des Kunden geklärt ist.
   */
  if (getSkontoFristStatus(invoice).status === 'ungeklaert') {
    return false;
  }

  // FINANZ-CORE-01A (ZAH-10, Feiertage) — § 193 BGB: überfällig erst nach dem spätestmöglichen Fristende.
  // INV-02 — bei offenem Ende (Ausland ohne Klärung) nie: erst das geprüfte Fristende entscheidet.
  const fenster = zahlungszielFenster(invoice);
  if (!fenster) return toDateOnly(today) > toDateOnly(invoice.paymentDueDate);
  return nachFristende(toDateOnly(today), fenster);
}

/**
 * FINANZ-CORE-01A (Gesamtnacharbeit INV-01/02) — das Zahlungsziel ist nach dem frühestmöglichen Ende
 * vorbei, aber ob es überschritten ist, hängt an einem Feiertag am Sitz des Kunden (oder an einem
 * ausländischen Fristende, das niemand geprüft hat). Dann gibt es keine Überfälligkeit und keine Mahnung,
 * sondern den Klärungsweg an der Rechnung. Eine ungeklärte Skontozahlung hat ihren eigenen Hinweis.
 */
export function isZahlungszielUngeklaert(invoice: VorgangInvoice, today: Date | string = new Date()): boolean {
  if (!isExpectingPayment(invoice) || !invoice.paymentDueDate || getOpenAmount(invoice) <= 0) return false;
  if (getSkontoFristStatus(invoice).status === 'ungeklaert') return false;
  const fenster = zahlungszielFenster(invoice);
  if (!fenster) return false;
  const tag = toDateOnly(today);
  return tag > fenster.fruehestens && !nachFristende(tag, fenster);
}

/** True when sent date is after payment due date — due date is not auto-adjusted. */
export function isSentDateAfterPaymentDue(
  sentAt: string | undefined,
  paymentDueDate: string | undefined,
): boolean {
  if (!sentAt?.trim() || !paymentDueDate?.trim()) return false;
  return toDateOnly(sentAt) > toDateOnly(paymentDueDate);
}

/**
 * FINANZCORE-05C — die Regel liegt jetzt in `paymentSemantics`, weil die
 * Ausgabenseite dieselbe braucht. Der Name bleibt: An ihm haengen Aufrufer
 * und Tests, und die Bedeutung hat sich nicht geaendert.
 */
export function getPaymentOverpayAmount(openAmount: number, paymentAmount: number): number {
  return getPaymentOverpayAmountShared(openAmount, paymentAmount);
}

/**
 * FINANZCORE-05C — darf auf diese Rechnung noch eine normale Zahlung?
 *
 * Bis hierher wurde „Zahlung erfassen" ueberall angeboten, solange die
 * Rechnung nicht storniert war — auch auf einer vollstaendig bezahlten. Ein
 * fachlicher Grund dafuer war weder im Code noch in den Tests hinterlegt; es
 * war schlicht die einzige gepruefte Bedingung. Genau darueber entstand die
 * versehentliche Mehrfachueberzahlung, vor der die Bestaetigung schuetzen
 * soll.
 *
 * Eine Korrektur bleibt moeglich: Die Zahlungsliste auf der Detailseite nimmt
 * eine Zahlung zurueck, danach ist wieder etwas offen.
 */
export function canRecordInvoicePayment(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
): boolean {
  if (isInvoiceCancelled(invoice)) return false;
  return !isSettledPaymentStatus(resolvePaymentStatus(invoice, today));
}

/** FINANZCORE-05C — verlangt dieser Betrag eine ausdrueckliche Bestaetigung? */
export function willInvoicePaymentNeedOverpayConfirm(
  openAmount: number,
  paymentAmount: number,
): boolean {
  return requiresOverpaymentConfirmation(openAmount, paymentAmount);
}

/** Prepared invoices require an explicit confirmation before recording payment. */
export function willPaymentNeedUnsentConfirm(invoice: VorgangInvoice): boolean {
  return invoice.status === 'vorbereitet' && !isInvoiceCancelled(invoice);
}

export function calculatePaymentSummary(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
): PaymentSummary {
  const totalDue = invoice.amount;
  const paidAmount = getPaidAmount(invoice);
  /* Dieselbe Quelle wie überall — der Skontoausgleich darf nicht zweimal
     unterschiedlich gerechnet werden. */
  const openAmount = getOpenAmount(invoice);
  const overpaidAmount = calculateOverpaidAmount(totalDue, paidAmount);
  const status = resolvePaymentStatus(invoice, today, {
    paidAmount,
    openAmount,
    overpaidAmount,
  });

  return {
    totalDue,
    paidAmount,
    openAmount,
    overpaidAmount,
    status,
  };
}

export function resolvePaymentStatus(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
  amounts?: Pick<PaymentSummary, 'paidAmount' | 'openAmount' | 'overpaidAmount'>,
): InvoicePaymentStatus {
  if (isInvoiceCancelled(invoice)) {
    return 'storniert';
  }

  const paidAmount = amounts?.paidAmount ?? getPaidAmount(invoice);
  const openAmount = amounts?.openAmount ?? getOpenAmount(invoice);
  const overdue = isInvoiceOverdue({ ...invoice, payments: invoice.payments ?? [] }, today);

  /*
   * FINANZCORE-05C — dieselbe Reihenfolge wie bei den Ausgaben, aus einer
   * Quelle. Neu ist allein, dass eine Ueberzahlung nicht mehr als „bezahlt"
   * durchgeht.
   *
   * `overpaidAmount` haengt an `invoice.amount`, nicht am offenen Betrag. Ein
   * per Skonto ausgeglichener Beleg — bei dem `getOpenAmount` bewusst 0
   * liefert, obwohl weniger als der volle Betrag geflossen ist — bleibt
   * dadurch „bezahlt" und wird nicht faelschlich zur Ueberzahlung.
   */
  const overpaidAmount =
    amounts?.overpaidAmount ?? calculateOverpaidAmount(invoice.amount, paidAmount);

  return resolveSettlementStatus({ paidAmount, openAmount, overpaidAmount, overdue });
}

export function normalizeInvoicePaymentFields(invoice: VorgangInvoice): VorgangInvoice {
  const payments = getInvoicePayments(invoice);
  const summary = calculatePaymentSummary({ ...invoice, payments });

  return {
    ...invoice,
    payments,
    paymentStatus: summary.status,
  };
}

export interface RecordPaymentOptions {
  /** Required when invoice.status is `vorbereitet` — does not change send status. */
  confirmUnsent?: boolean;
  /** Required when amount exceeds the current open remainder. */
  confirmOverpayment?: boolean;
  /**
   * GO-LIVE-SECURITY-01 / ABSCHLUSS — wer bucht. Mit Angabe prüft der Dienst die Rolle vor
   * jeder lokalen Änderung, fail-closed: Ein Mitglied oder eine ungeklärte Rolle bucht nichts
   * (der Server weist es mit finance_forbidden_role ab, und ein lokaler Scheinerfolg zeigte die
   * Rechnung auf diesem Gerät als bezahlt). Ohne Angabe wie bisher (Altaufrufer, Tests); die
   * Oberfläche gibt den Akteur immer mit.
   */
  actor?: WorkspaceActor;
}

export function recordPayment(
  /**
   * MANUAL-INVOICE-01B2c — `null` ist die Rechnung ohne Auftrag. Sämtliche
   * Regeln darunter (finalisiert, nicht storniert, Betrag, Datum, Confirm-first
   * bei unversendet und Überzahlung) gelten unverändert; nur der Ablageort
   * der Zahlung ist ein anderer.
   */
  vorgangId: string | null,
  invoiceId: string,
  input: InvoicePaymentInput,
  options: RecordPaymentOptions = {},
): PaymentMutationResult {
  if (options.actor && !resolveWorkspaceWriteAccess(options.actor).canWrite) {
    return { success: false, errorKey: 'payment.forbidden' };
  }

  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { success: false, errorKey: 'payment.invoiceNotFound' };
  }

  if (!isFinalizedInvoice(invoice)) {
    return { success: false, errorKey: 'payment.invoiceNotFinalized' };
  }

  if (isInvoiceCancelled(invoice)) {
    return { success: false, errorKey: 'payment.invoiceCancelled' };
  }

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { success: false, errorKey: 'payment.amountInvalid' };
  }

  if (!input.date?.trim()) {
    return { success: false, errorKey: 'payment.dateRequired' };
  }

  if (invoice.status === 'vorbereitet' && !options.confirmUnsent) {
    return { success: false, errorKey: 'payment.unsentConfirmationRequired' };
  }

  /*
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-03) — Zahlung und Skonto dieses Abschlags hat eine wirksame
   * Schlussrechnung eingefroren: keine neue Zahlung, gleich wie hoch der offene Betrag erscheint. Geld
   * danach gehört auf die Schlussrechnung (Server: invoice_payment_final_invoice_exists).
   */
  if (hasFrozenFinalInvoiceDeduction(vorgangId, invoice)) {
    return { success: false, errorKey: 'payment.finalInvoiceExists' };
  }

  /*
   * FINANZ-CORE-01A (Feiertage) — hängt das Skonto an einem ungeklärten Feiertag am Sitz des Kunden,
   * wird erst der Ort geklärt: Eine weitere Zahlung wäre je nach Ort geschuldet oder eine Überzahlung.
   * Der Server weist sie ebenso ab (`invoice_skonto_deadline_unclear`).
   */
  if (getSkontoFristStatus(invoice).status === 'ungeklaert') {
    return { success: false, errorKey: 'payment.skontoDeadlineUnclear' };
  }

  const openAmount = getOpenAmount(invoice);
  const overpayAmount = getPaymentOverpayAmount(openAmount, input.amount);
  /*
   * FC01A-P1-Nacharbeit (ZAH-04) — ein Abschlag, den eine wirksame Schlussrechnung als beglichen
   * abzieht, nimmt über seinen offenen Betrag hinaus keine Zahlung an, auch nicht bestätigt: Die
   * Schlussrechnung hat Zahlung und Skonto eingefroren. Der Server
   * (`add_workspace_invoice_payment`) weist das ebenso ab; Geld danach gehört auf die Schlussrechnung.
   */
  if (overpayAmount > 0 && findFinalInvoiceBlockingPaymentReversal(vorgangId, invoice)) {
    return { success: false, errorKey: 'payment.finalInvoiceExists' };
  }
  if (overpayAmount > 0 && !options.confirmOverpayment) {
    return { success: false, errorKey: 'payment.overpaymentConfirmationRequired' };
  }

  /*
   * PAYMENT-FOUNDATION-04B2A — die Kennung wird genau einmal erzeugt und ist
   * eine echte UUID. Der frühere `pay-${Date.now()}` war zwischen zwei Geräten
   * kein tragfähiger Idempotenzschlüssel: Zwei Zahlungen in derselben
   * Millisekunde teilten sich eine Kennung, und ein späterer Abgleich hätte
   * zwei echte Geldbewegungen zu einer verschmolzen.
   *
   * Bestehende `pay-…`-Kennungen bleiben unangetastet — eine gebuchte Zahlung
   * ist ein Beleg, kein Formatproblem.
   */
  const method = normalizePaymentMethod(input.method);
  const payment: InvoicePayment = {
    id: generateUuid(),
    date: input.date.slice(0, 10),
    amount: input.amount,
    reference: input.reference?.trim() || undefined,
    note: input.note?.trim() || undefined,
    // 02B — optional; ohne Angabe bleibt sie nicht erfasst (nie „Bank“ angenommen).
    ...(method ? { method } : {}),
    createdAt: new Date().toISOString(),
    // FINANZ-CORE-01A (SQL-05) — die Bestätigung reist mit; der Server verlangt sie.
    ...(overpayAmount > 0 ? { overpaymentAcknowledged: true } : {}),
  };

  const summary = calculatePaymentSummary({
    ...invoice,
    payments: [...getInvoicePayments(invoice), payment],
  });

  const updated = addPaymentToInvoice(vorgangId, invoiceId, payment, summary.status);
  if (!updated.ok) {
    return {
      success: false,
      errorKey:
        updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }

  /*
   * P0/P1-INTEGRITAET 01B / P1 — ist die Forderung jetzt erledigt (voll, Rest,
   * Skonto, Überzahlung), schliesst sich ihre Überfälligkeitsaufgabe. Eine
   * Teilzahlung lässt sie offen. Die Zahlung ist bereits gespeichert; ein
   * Fehler hier darf sie nicht als gescheitert melden.
   */
  try {
    // 02B — Teilzahlung: offene Aufgabe zeigt den neuen offenen Betrag.
    reconcileInvoicePaymentTasks({ invoiceId });
  } catch (error) {
    console.warn('[payment] Überfälligkeitsaufgabe konnte nicht abgeglichen werden', error);
  }

  return { success: true, invoice: updated.invoice, payment };
}

export function removePayment(
  vorgangId: string | null,
  invoiceId: string,
  paymentId: string,
): RemovePaymentResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { success: false, errorKey: 'payment.invoiceNotFound' };
  }

  const payments = getInvoicePayments(invoice);
  if (!payments.some((payment) => payment.id === paymentId)) {
    return { success: false, errorKey: 'payment.notFound' };
  }

  // FC01A-Nacharbeit (A2) — hinter einer wirksamen Schlussrechnung bleibt die Abschlagszahlung stehen.
  if (findFinalInvoiceBlockingPaymentReversal(vorgangId, invoice)) {
    return { success: false, errorKey: 'payment.reverseBlockedByFinalInvoice' };
  }

  const remaining = payments.filter((payment) => payment.id !== paymentId);
  const summary = calculatePaymentSummary({ ...invoice, payments: remaining });
  const updated = removePaymentFromInvoice(vorgangId, invoiceId, paymentId, summary.status);

  if (!updated.ok) {
    return {
      success: false,
      errorKey:
        updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }

  /*
   * 02B — ist die Rechnung durch die Rücknahme wieder überfällig, entsteht die
   * neue offene Überfälligkeitsaufgabe sofort über den bestehenden Dedupe; die
   * frühere, erledigte Episode bleibt Historie.
   */
  try {
    // FINANZ-CORE-01A (ZAH-06) — die Rücknahme beginnt eine neue Episode, auch nach einer erledigten Aufgabe.
    reconcileInvoicePaymentTasks({ invoiceId, newEpisode: true });
  } catch (error) {
    console.warn('[payment] Überfälligkeitsaufgabe konnte nicht abgeglichen werden', error);
  }

  return { success: true, invoice: updated.invoice };
}

/* -------------------------------------------------------------------------- */
/* PAYMENT-CLOUD-DURABILITY-04B2B                                             */
/* -------------------------------------------------------------------------- */

/**
 * PAYMENT-CLOUD-CLOSURE-04B2B1 — für eine Geldbewegung ist nur `synced` genug.
 *
 * Beim Versandstatus durfte `supabase_not_configured` schweigen: ohne Cloud
 * gibt es dort nichts zu sichern. Bei einer Zahlung ist das anders — sie steht
 * dann nachweislich nur auf diesem Gerät, und genau das muss der Nutzer wissen.
 * Deshalb ein eigenes, strengeres Prädikat statt des geteilten `…Silent`.
 */
export function isInvoicePaymentCloudSynced(outcome: InvoicePaymentCloudOutcome): boolean {
  return outcome === 'synced';
}

/**
 * Sichert eine **bereits lokal gespeicherte** Zahlung in der Cloud.
 *
 * Bewusst ein eigener Schritt nach dem lokalen Commit: Die Zahlung ist damit
 * bereits erfasst und wird bei einem Cloud-Fehler nicht zurückgenommen — der
 * Nutzer hat sie schließlich gebucht. Gemeldet wird nur, ob sie auch
 * geräteübergreifend gesichert ist.
 *
 * Es wird **nie** eine neue Kennung erzeugt: Ein Wiederholungsversuch nutzt
 * dieselbe `payment.id` und trifft damit denselben Idempotenzschlüssel.
 */
export async function syncInvoicePaymentToCloud(
  invoiceId: string,
  payment: InvoicePayment,
): Promise<InvoicePaymentCloudOutcome> {
  /*
   * FINANZ-CORE-01A (Bericht 20) — bis der Server antwortet, ist die lokal gebuchte Zahlung keine bestätigte
   * Finanztatsache: vermerkt, bevor gesendet wird (auch ein Abbruch mitten im Senden lässt den Vermerk stehen).
   * Bestätigt (`synced`) oder reiner Lokalbetrieb ohne Cloud (`supabase_not_configured`) heben ihn auf; jeder
   * andere Ausgang lässt ihn stehen — der Monatsabschluss sperrt, bis der Server sie kennt.
   */
  markInvoicePaymentUnconfirmed(invoiceId, payment.id);
  let outcome: InvoicePaymentCloudOutcome;
  try {
    const { addInvoicePaymentToCloud } = await import(
      './invoice/workspaceInvoicePaymentCloudService'
    );
    const result = await addInvoicePaymentToCloud({
      clientInvoiceId: invoiceId,
      clientPaymentId: payment.id,
      amount: payment.amount,
      paidOn: payment.date,
      reference: payment.reference,
      note: payment.note,
      method: payment.method,
      overpaymentAcknowledged: payment.overpaymentAcknowledged === true,
    });
    outcome = result.outcome;
  } catch {
    outcome = 'failed';
  }
  if (outcome === 'synced' || outcome === 'supabase_not_configured') clearInvoicePaymentUnconfirmed(invoiceId, payment.id);
  // Systemische Gesamtnacharbeit (D4) — nur die Serverantwort „gebucht“ ist positive Evidenz, dauerhaft an der Zahlung.
  if (outcome === 'synced') setInvoicePaymentCloudConfirmation(invoiceId, new Map([[payment.id, true]]));
  return outcome;
}

/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, SYS-02 / D4) — die Serverbestätigung von Zahlungen einer Rechnung
 * setzen (`true`) oder entziehen (`false`, der vollständige Nachgleich belegt: der Server kennt sie nicht).
 * Kennungen, Beträge und Reihenfolge bleiben; geschrieben und gespeichert wird nur bei einer echten Änderung.
 * Scheitert das Speichern, nimmt der Commit die Änderung zurück — die Zahlung bleibt dann unbestätigt.
 */
export function setInvoicePaymentCloudConfirmation(
  invoiceId: string,
  confirmations: ReadonlyMap<string, boolean>,
): boolean {
  const entry = listInvoiceEntries().find((item) => item.invoice.id === invoiceId);
  if (!entry) return false;
  let changed = false;
  const payments = getInvoicePayments(entry.invoice).map((payment) => {
    const soll = confirmations.get(payment.id);
    if (soll === undefined || (payment.cloudBestaetigt === true) === soll) return payment;
    changed = true;
    if (soll) return { ...payment, cloudBestaetigt: true };
    const { cloudBestaetigt: _entzogen, ...rest } = payment;
    void _entzogen;
    return rest;
  });
  if (!changed) return true;
  const result = replaceInvoicePayments(
    entry.vorgangId,
    invoiceId,
    payments,
    entry.invoice.paymentStatus ?? calculatePaymentSummary({ ...entry.invoice, payments }).status,
  );
  return result.ok;
}

/**
 * FINANZ-CORE-01A (SQL-05/ZAH-02) — eine bereits gebuchte Zahlung nachträglich als
 * Überzahlung bestätigen.
 *
 * Der Server weist eine Überzahlung ohne Bestätigung ab. Das trifft vor allem den Fall,
 * dass ein anderes Gerät inzwischen eine Zahlung gesichert hat: Dann ist diese hier
 * entweder doppelt erfasst (der Nutzer entfernt sie) oder eine echte Überzahlung (er
 * bestätigt sie hier). Geändert wird nur das Merkmal — Kennung, Betrag und Datum
 * bleiben, damit der nächste Sicherungsversuch dieselbe Zahlung überträgt.
 */
export function acknowledgeInvoicePaymentOverpayment(
  vorgangId: string | null,
  invoiceId: string,
  paymentId: string,
): PaymentMutationResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return { success: false, errorKey: 'payment.invoiceNotFound' };
  if (isInvoiceCancelled(invoice)) return { success: false, errorKey: 'payment.invoiceCancelled' };
  const payments = getInvoicePayments(invoice);
  const payment = payments.find((entry) => entry.id === paymentId);
  if (!payment) return { success: false, errorKey: 'payment.notFound' };
  if (payment.overpaymentAcknowledged) return { success: true, invoice, payment };

  const acknowledged: InvoicePayment = { ...payment, overpaymentAcknowledged: true };
  const next = payments.map((entry) => (entry.id === paymentId ? acknowledged : entry));
  const summary = calculatePaymentSummary({ ...invoice, payments: next });
  const updated = replaceInvoicePayments(vorgangId, invoiceId, next, summary.status);
  if (!updated.ok) {
    return {
      success: false,
      errorKey: updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }
  return { success: true, invoice: updated.invoice, payment: acknowledged };
}

/* -------------------------------------------------------------------------- */
/* FINANZ-CORE-01A (Restnacharbeit END18-R3) — abgewiesene Zahlungen            */
/* -------------------------------------------------------------------------- */

const QUARANTINE_OUTCOMES: ReadonlySet<InvoicePaymentCloudOutcome> = new Set<InvoicePaymentCloudOutcome>([
  'overpayment_unconfirmed',
  'invoice_cancelled',
  'final_invoice_exists',
]);

/**
 * Ein Sicherungsausgang, nach dem die Zahlung beim Server nachweislich nicht existiert: Der Server prüft die
 * Wiederholung derselben Kennung vor allen fachlichen Regeln; eine fachliche Abweisung heißt „nie
 * angenommen“. Konflikt (andere Zahlung unter derselben Kennung), Rollenabweisung und Netzfehler zählen
 * nicht dazu.
 */
export function isRejectedInvoicePaymentOutcome(
  outcome: InvoicePaymentCloudOutcome,
): outcome is RejectedInvoicePaymentReason {
  return QUARANTINE_OUTCOMES.has(outcome);
}

/** Abgewiesene Zahlungen einer Rechnung (Nachweis, ohne Finanzwirkung). */
export function getRejectedInvoicePayments(invoice: VorgangInvoice): RejectedInvoicePayment[] {
  return (invoice.rejectedPayments ?? []).map((payment) => ({ ...payment }));
}

function afterPaymentMove(invoiceId: string): void {
  try {
    // Wie bei der Rücknahme: Ist die Rechnung dadurch wieder offen, beginnt eine neue Überfälligkeits-Episode.
    reconcileInvoicePaymentTasks({ invoiceId, newEpisode: true });
  } catch (error) {
    console.warn('[payment] Überfälligkeitsaufgabe konnte nicht abgeglichen werden', error);
  }
}

/**
 * Eine vom Server endgültig abgewiesene Zahlung verliert ihre Finanzwirkung: Sie wechselt aus `payments`
 * nach `rejectedPayments`. Bezahlt, offen, Status, Mahnung, Monatsmappe, Export und Abschluss folgen allein
 * `payments`; die Zahlung bleibt als Nachweis sichtbar, bis der Nutzer entscheidet. Keine stille Löschung,
 * kein automatischer neuer Versuch (der dauerhafte Vermerk bleibt, `recordInvoicePaymentResyncBlock`).
 */
export function quarantineRejectedInvoicePayment(
  vorgangId: string | null,
  invoiceId: string,
  paymentId: string,
  reason: RejectedInvoicePaymentReason,
  rejectedAt: string = new Date().toISOString(),
): PaymentMutationResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return { success: false, errorKey: 'payment.invoiceNotFound' };
  const payments = getInvoicePayments(invoice);
  const payment = payments.find((entry) => entry.id === paymentId);
  if (!payment) return { success: false, errorKey: 'payment.notFound' };
  const remaining = payments.filter((entry) => entry.id !== paymentId);
  const rejected: RejectedInvoicePayment[] = [
    ...getRejectedInvoicePayments(invoice).filter((entry) => entry.id !== paymentId),
    { ...payment, rejectedAt, reason },
  ];
  const summary = calculatePaymentSummary({ ...invoice, payments: remaining });
  const updated = moveInvoicePayments(vorgangId, invoiceId, remaining, rejected, summary.status);
  if (!updated.ok) {
    return {
      success: false,
      errorKey: updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }
  afterPaymentMove(invoiceId);
  return { success: true, invoice: updated.invoice, payment };
}

/**
 * Der Nutzer bestätigt eine als unbestätigte Überzahlung abgewiesene Zahlung bewusst: Sie kehrt mit dem
 * Bestätigungsmerkmal unter dieselbe Kennung zurück und wird danach gesendet. Nur für
 * `overpayment_unconfirmed` — eine stornierte Rechnung oder ein durch die Schlussrechnung abgerechneter
 * Abschlag nimmt auch eine bestätigte Zahlung nicht an.
 */
export function restoreRejectedInvoicePaymentAsOverpayment(
  vorgangId: string | null,
  invoiceId: string,
  paymentId: string,
): PaymentMutationResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return { success: false, errorKey: 'payment.invoiceNotFound' };
  if (isInvoiceCancelled(invoice)) return { success: false, errorKey: 'payment.invoiceCancelled' };
  const rejected = getRejectedInvoicePayments(invoice);
  const entry = rejected.find((item) => item.id === paymentId);
  if (!entry) return { success: false, errorKey: 'payment.notFound' };
  if (entry.reason !== 'overpayment_unconfirmed') return { success: false, errorKey: 'payment.rejectedNotRestorable' };
  const { rejectedAt: _rejectedAt, reason: _reason, ...payment } = entry;
  const acknowledged: InvoicePayment = { ...payment, overpaymentAcknowledged: true };
  const payments = [...getInvoicePayments(invoice), acknowledged];
  const summary = calculatePaymentSummary({ ...invoice, payments });
  const updated = moveInvoicePayments(
    vorgangId,
    invoiceId,
    payments,
    rejected.filter((item) => item.id !== paymentId),
    summary.status,
  );
  if (!updated.ok) {
    return {
      success: false,
      errorKey: updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }
  afterPaymentMove(invoiceId);
  return { success: true, invoice: updated.invoice, payment: acknowledged };
}

/** Der Nutzer verwirft den Nachweis einer abgewiesenen Zahlung bewusst (der Server kannte sie nie). */
export function discardRejectedInvoicePayment(
  vorgangId: string | null,
  invoiceId: string,
  paymentId: string,
): RemovePaymentResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) return { success: false, errorKey: 'payment.invoiceNotFound' };
  const rejected = getRejectedInvoicePayments(invoice);
  if (!rejected.some((item) => item.id === paymentId)) return { success: false, errorKey: 'payment.notFound' };
  const payments = getInvoicePayments(invoice);
  const updated = moveInvoicePayments(
    vorgangId,
    invoiceId,
    payments,
    rejected.filter((item) => item.id !== paymentId),
    calculatePaymentSummary({ ...invoice, payments }).status,
  );
  if (!updated.ok) {
    return {
      success: false,
      errorKey: updated.reason === 'persist_failed' ? 'payment.persistFailed' : 'payment.invoiceNotFound',
    };
  }
  return { success: true, invoice: updated.invoice };
}

/**
 * Storniert eine Zahlung in der Cloud. **Vor** dem lokalen Entfernen aufzurufen:
 * Ein hartes lokales Löschen bei fehlgeschlagenem Reversal ließe die Zahlung
 * beim nächsten Pull überraschend wieder erscheinen.
 */
export async function reverseInvoicePaymentInCloudForRemoval(
  invoiceId: string,
  paymentId: string,
): Promise<InvoicePaymentCloudOutcome> {
  try {
    const { reverseInvoicePaymentInCloud } = await import(
      './invoice/workspaceInvoicePaymentCloudService'
    );
    const result = await reverseInvoicePaymentInCloud({
      clientInvoiceId: invoiceId,
      clientPaymentId: paymentId,
    });
    return result.outcome;
  } catch {
    return 'failed';
  }
}

/**
 * Zahlungen, die lokal existieren, in der Cloud aber unbekannt sind.
 *
 * Grundlage des Confirm-first-Hinweises „noch nicht in der Cloud gesichert".
 * **Nur nach einem nachweislich erfolgreichen Pull aufrufen** — unbekannt ist
 * nicht dasselbe wie ungesichert.
 */
export function findLocallyOnlyPayments(
  invoice: VorgangInvoice,
  cloudPaymentIds: readonly string[],
): InvoicePayment[] {
  const known = new Set(cloudPaymentIds);
  return getInvoicePayments(invoice).filter((payment) => !known.has(payment.id));
}

export function getOverdueDays(
  invoice: VorgangInvoice,
  today: Date | string = new Date(),
): number {
  if (!invoice.paymentDueDate || !isInvoiceOverdue(invoice, today)) {
    return 0;
  }

  // FINANZ-CORE-01A (ZAH-10, Feiertage) — gezählt ab dem wirksamen (spätestmöglichen) Fristende.
  const fenster = zahlungszielFenster(invoice);
  if (fenster && fenster.spaetestens === null) return 0;
  const due = new Date(fenster?.spaetestens ?? toDateOnly(invoice.paymentDueDate));
  const now = new Date(toDateOnly(today));
  const diffMs = now.getTime() - due.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function summarizeVorgangInvoicePayments(invoices: VorgangInvoice[]): {
  openTotal: number;
  paidTotal: number;
} {
  let openTotal = 0;
  let paidTotal = 0;

  for (const invoice of invoices) {
    if (!isFinalizedInvoice(invoice)) continue;
    const summary = calculatePaymentSummary(invoice);
    openTotal += summary.openAmount;
    paidTotal += summary.paidAmount;
  }

  return { openTotal, paidTotal };
}

export function formatPaymentCurrency(value: number): string {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
