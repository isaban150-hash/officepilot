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
import { buildSkontoDeadlineWindow, parseSkontoFromText } from '../invoiceTaxService';
import { invoiceFristLage, type FristFenster } from '../fristen/fristende';

function toDateOnly(value: Date | string): string {
  if (typeof value !== 'string') return getBusinessDay(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value.trim()) ? toBusinessDay(value) : value.slice(0, 10);
}

/**
 * `null` ohne gültiges Skonto, nach Ablauf der Frist, bei Storno oder wenn nichts mehr fehlt.
 *
 * FINANZ-CORE-01A (Feiertage) — Frist ist das frühestmögliche Ende am Sitz des Kunden (§ 193 BGB). Ein
 * Zahlungstag danach, der nur bei einem ungeklärten Feiertag noch rechtzeitig wäre, bekommt keinen
 * Skontotreffer: Der Abgleich entscheidet die offene Frage nicht (Server: `workspace_invoice_open_cents`).
 */
export function getSkontoSettlementRemainderCents(invoice: VorgangInvoice, onDate: string): number | null {
  if (invoice.paymentStatus === 'storniert' || invoice.cancelledAt) return null;
  const skontoText = invoice.skontoText?.trim();
  if (!skontoText) return null;
  const parsed = parseSkontoFromText(skontoText);
  if (!parsed) return null;
  const baseDate = invoice.issueDate ?? invoice.date;
  if (!baseDate?.trim()) return null;
  const deadline = buildSkontoDeadlineWindow(baseDate, parsed.days, invoiceFristLage(invoice)).fruehestens;
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

export type SkontoFristStatus =
  | { status: 'ohne' }
  | { status: 'offen'; fenster: FristFenster }
  | { status: 'beglichen'; fenster: FristFenster; payableCents: number }
  | { status: 'ungeklaert'; fenster: FristFenster; payableCents: number };

/**
 * FINANZ-CORE-01A (Feiertage, § 193 BGB) — wie die Skontozahlung zum wirksamen Fristende steht.
 *
 *  - `beglichen`: bis zum frühestmöglichen Fristende ist mindestens der Betrag nach Skonto gezahlt;
 *  - `ungeklaert`: erst bis zum spätestmöglichen — ob das reicht, hängt an einem Feiertag am Sitz des
 *    Kunden, den die App nicht sicher kennt. Keine verbindliche Entscheidung: kein „verspätet“, keine
 *    Überfälligkeit, keine Schlussrechnung und keine weitere Zahlung, bis der Ort am Kunden steht
 *    (der Server weist beides mit `invoice_skonto_deadline_unclear` ab);
 *  - `offen`: kein rechtzeitiges Skonto; `ohne`: kein lesbares Skonto oder kein Basisdatum.
 */
export function getSkontoFristStatus(invoice: VorgangInvoice): SkontoFristStatus {
  const skontoText = invoice.skontoText?.trim();
  if (!skontoText) return { status: 'ohne' };

  const parsed = parseSkontoFromText(skontoText);
  if (!parsed) return { status: 'ohne' };

  const baseDate = invoice.issueDate ?? invoice.date;
  if (!baseDate?.trim()) return { status: 'ohne' };

  const fenster = buildSkontoDeadlineWindow(baseDate, parsed.days, invoiceFristLage(invoice));
  const payments = (invoice.payments ?? []).filter((payment) => payment.date);
  const paidUntil = (day: string) =>
    sumCents(payments.filter((payment) => toDateOnly(payment.date) <= day).map((payment) => toCents(payment.amount)));

  // FINANZ-CORE-01A — Zahlbetrag nach Skonto in Cent, eine Rundung; ein Cent Toleranz wie bisher.
  const payableCents = Math.round((toCents(invoice.amount) * (100 - parsed.percent)) / 100);
  if (paidUntil(fenster.fruehestens) + 1 >= payableCents) return { status: 'beglichen', fenster, payableCents };
  // INV-02 — ein offenes Ende (Ausland ohne Klärung) zählt jede spätere Zahlung als ungeklärt, nie als verspätet.
  const bisSpaetestens =
    fenster.spaetestens === null
      ? sumCents(payments.map((payment) => toCents(payment.amount)))
      : paidUntil(fenster.spaetestens);
  if (bisSpaetestens + 1 >= payableCents) return { status: 'ungeklaert', fenster, payableCents };
  return { status: 'offen', fenster };
}
