/**
 * INVOICE-SENT-CLOUD-DURABILITY-01B — was ein Versandsatz ist.
 *
 * Bewusst ein eigenes, **abhängigkeitsfreies** Modul: Dieselbe Definition wird
 * an drei Stellen gebraucht — im Sent-Dienst, im Cloud-Client und im Merge in
 * `vorgangService`. Läge sie im Sent-Dienst, entstünde ein Importzyklus über
 * `vorgangService`; läge sie mehrfach nebeneinander, würden die Fassungen
 * irgendwann auseinanderlaufen und genau die Inkonsistenz erzeugen, die dieser
 * Block beseitigt.
 *
 * Ein Versandsatz gilt nur **gemeinsam**: Status, gültiges Datum und gültiger
 * Weg. Fehlt eines davon, ist es kein Versand — lieber „vorbereitet" als
 * „Versendet — Datum —".
 */
import type { InvoiceSentVia, VorgangInvoice } from '../../types/models';

export const INVOICE_SENT_VIA_VALUES: readonly InvoiceSentVia[] = [
  'email',
  'post',
  'persoenlich',
  'portal',
  'sonstige',
] as const;

export interface InvoiceSentSnapshot {
  sentAt: string;
  sentVia: InvoiceSentVia;
  /** Optional — und ausdrücklich löschbar. Fehlend ist nicht dasselbe wie leer. */
  sentNote?: string;
}

export function isInvoiceSentVia(value: unknown): value is InvoiceSentVia {
  return (
    typeof value === 'string' && (INVOICE_SENT_VIA_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Form **und** echter Kalender. Ohne den zweiten Schritt kämen `2026-02-30`
 * und `2026-04-31` durch — beides gibt es nicht.
 */
export function isSentIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === trimmed;
}

/** Baut einen Versandsatz aus losen Feldern — oder `null`, wenn er unvollständig ist. */
export function buildInvoiceSentSnapshot(input: {
  status?: unknown;
  sentAt?: unknown;
  sentVia?: unknown;
  sentNote?: unknown;
}): InvoiceSentSnapshot | null {
  if (input.status !== 'versendet') return null;
  if (!isSentIsoDate(input.sentAt)) return null;
  if (!isInvoiceSentVia(input.sentVia)) return null;

  const note = typeof input.sentNote === 'string' ? input.sentNote.trim() : '';
  const snapshot: InvoiceSentSnapshot = {
    sentAt: input.sentAt.trim(),
    sentVia: input.sentVia,
  };
  if (note) snapshot.sentNote = note;
  return snapshot;
}

/** Der Versandsatz einer Rechnung — `null`, solange er nicht vollständig ist. */
export function readInvoiceSentSnapshot(invoice: VorgangInvoice): InvoiceSentSnapshot | null {
  return buildInvoiceSentSnapshot({
    status: invoice.status,
    sentAt: invoice.sentAt,
    sentVia: invoice.sentVia,
    sentNote: invoice.sentNote,
  });
}

/**
 * Gleichheit einschliesslich „Notiz fehlt" gegen „Notiz gesetzt". Eine gelöschte
 * Notiz ist eine echte Änderung und darf nicht als synchron durchgehen.
 */
export function sentSnapshotsEqual(
  a: InvoiceSentSnapshot | null,
  b: InvoiceSentSnapshot | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.sentAt === b.sentAt &&
    a.sentVia === b.sentVia &&
    (a.sentNote ?? null) === (b.sentNote ?? null)
  );
}
