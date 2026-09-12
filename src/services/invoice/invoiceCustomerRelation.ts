/**
 * MANUAL-INVOICE-CUSTOMER-IDENTITY-01B — die Kundenrelation einer Rechnung.
 *
 * Zwei getrennte Ebenen, bewusst nicht vermischt:
 *
 *  1. **Beleginhalt** — `customerSnapshot`, Positionen, Beträge,
 *     Leistungsdaten. Historische Wahrheit, abgesichert über
 *     `immutableInvoiceFingerprint` / Content-Fingerprint.
 *  2. **Kundenrelation** — `customerId`. Interne relationale Identität,
 *     set-once, **nicht** Bestandteil der Dokumentdarstellung und deshalb
 *     nicht im Fingerprint. Sie wird hier separat auf Verträglichkeit geprüft;
 *     der Content-Fingerprint erkennt einen Kundenkonflikt ausdrücklich nicht.
 *
 * Dieses Modul ist die einzige Definition beider Regeln — Merge-Verträglichkeit
 * und Leseregel. Wer sie braucht, ruft sie; niemand baut sie nach.
 */
import type { Vorgang, VorgangInvoice } from '../../types/models';

export type InvoiceCustomerRelationResult =
  | { ok: true; customerId: string | undefined; filledFromRemote: boolean }
  | { ok: false; reason: 'customer_relation_conflict'; local: string; remote: string };

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Merge-Regel für `customerId` zwischen einer lokalen und einer entfernten
 * Fassung derselben Rechnung:
 *
 *   fehlt / fehlt          → ok, keine Relation
 *   fehlt / Wert           → Wert übernehmen (Lücke füllen)
 *   Wert  / fehlt          → lokalen Wert behalten
 *   Wert  / gleicher Wert  → ok
 *   Wert  / anderer Wert   → **Konflikt** — nie „local wins", nie „remote
 *                            wins", nie still, nie über den Namen entschieden.
 */
export function resolveInvoiceCustomerRelation(
  local: string | undefined,
  remote: string | undefined,
): InvoiceCustomerRelationResult {
  const a = normalize(local);
  const b = normalize(remote);
  if (a === undefined && b === undefined) return { ok: true, customerId: undefined, filledFromRemote: false };
  if (a === undefined) return { ok: true, customerId: b, filledFromRemote: true };
  if (b === undefined) return { ok: true, customerId: a, filledFromRemote: false };
  if (a === b) return { ok: true, customerId: a, filledFromRemote: false };
  return { ok: false, reason: 'customer_relation_conflict', local: a, remote: b };
}

/**
 * Leseregel Rechnung → Kunde:
 *
 *   1. `invoice.customerId`, wenn vorhanden
 *   2. sonst `vorgang.customerId` als Rückfall für den Altbestand
 *   3. sonst keine Zuordnung
 *
 * Nie über `customerSnapshot.name`, `customer`, Firma, Adresse oder E-Mail.
 * Ein Vorgang ohne Kennung liefert nichts — auch nicht seinen Kundennamen.
 */
export function resolveInvoiceCustomerId(
  invoice: Pick<VorgangInvoice, 'customerId'>,
  vorgang?: Pick<Vorgang, 'customerId'> | null,
): string | undefined {
  return normalize(invoice.customerId) ?? normalize(vorgang?.customerId);
}
