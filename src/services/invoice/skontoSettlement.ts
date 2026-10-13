/**
 * FINANZ-CORE-01A (ZAH-04) — was am Tag `onDate` noch zu zahlen ist, damit eine Rechnung mit Skonto
 * ausgeglichen ist.
 *
 * Der Bankabgleich kannte kein Skonto: Eine fristgerechte Skontozahlung (980 € auf 1.000 €) bekam
 * keinen Betragstreffer, und der Dialog nannte sie „Teilzahlung — danach bleibt ein Rest offen",
 * obwohl die Rechnung danach als bezahlt gilt.
 *
 * Dieselbe Regel wie `resolveSkontoSettledAmount` im Zahlungsdienst: Frist am Zahlungstag, nur der
 * volle Skontobetrag heilt, ohne belastbaren Satz und Frist kein Skonto. Ein eigenes, nur lesendes
 * Modul: Der Bankabgleich soll keinen Zahlungsdienst importieren (er bucht nie selbst).
 */
import type { VorgangInvoice } from '../../types/models';
import { getBusinessDay, toBusinessDay } from '../businessDateService';
import { sumCents, toCents } from '../invoiceMoney';
import { buildSkontoDeadline, parseSkontoFromText } from '../invoiceTaxService';

function toDateOnly(value: Date | string): string {
  if (typeof value !== 'string') return getBusinessDay(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value.trim()) ? toBusinessDay(value) : value.slice(0, 10);
}

/** `null` ohne gültiges Skonto, nach Ablauf der Frist, bei Storno oder wenn nichts mehr fehlt. */
export function getSkontoSettlementRemainderCents(invoice: VorgangInvoice, onDate: string): number | null {
  if (invoice.paymentStatus === 'storniert' || invoice.cancelledAt) return null;
  const skontoText = invoice.skontoText?.trim();
  if (!skontoText) return null;
  const parsed = parseSkontoFromText(skontoText);
  if (!parsed) return null;
  const baseDate = invoice.issueDate ?? invoice.date;
  if (!baseDate?.trim()) return null;
  const deadline = buildSkontoDeadline(baseDate, parsed.days);
  if (toDateOnly(onDate) > deadline) return null;
  const timelyPaidCents = sumCents(
    (invoice.payments ?? [])
      .filter((payment) => payment.date && toDateOnly(payment.date) <= deadline)
      .map((payment) => toCents(payment.amount)),
  );
  const payableCents = Math.round((toCents(invoice.amount) * (100 - parsed.percent)) / 100);
  const rest = payableCents - timelyPaidCents;
  return rest > 0 ? rest : null;
}
