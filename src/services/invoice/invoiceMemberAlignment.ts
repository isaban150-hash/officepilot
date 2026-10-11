/**
 * GO-LIVE-SECURITY-01 — Rechnungsfakten auf dem Gerät eines Mitglieds.
 *
 * Den Versand vermerken und den Leistungszeitraum bestätigen dürfen nur
 * Inhaber und Verwaltung; der Server weist beides bei Mitgliedern ab
 * (`update_workspace_invoice_sent`, `confirm_workspace_invoice_service_period`).
 * Beide Aktionen ändern aber zuerst lokal. Auf dem Gerät eines Mitglieds kann
 * deshalb ein Stand liegen, den die Cloud nicht kennt: aus einer abgewiesenen
 * Aktion oder aus einer, die vor dieser Regel offline erfasst wurde.
 *
 * Ein solcher Stand ist nicht freigegeben. Er darf weder PDF und Druck noch
 * eine Mahnung freigeben. Für eine **bekannte** Mitgliedsrolle gilt deshalb der
 * Stand der Cloud. Inhaber und Verwaltung behalten ihren lokalen Stand: Dort ist
 * eine Abweichung ein noch nicht gesicherter Vermerk, kein unberechtigter.
 *
 * Reine Funktionen ohne Speicherzugriff — der Pull und die Detailseite rufen
 * dieselben Regeln.
 */
import type { VorgangInvoice } from '../../types/models';
import { readInvoiceSentSnapshot, sentSnapshotsEqual, type InvoiceSentSnapshot } from './invoiceSentSnapshot';

/** Die Versandfelder einer Rechnung, vollständig — auch Herkunft und E-Mail-Bezug. */
export const INVOICE_SENT_STATE_KEYS = [
  'status',
  'sentAt',
  'sentVia',
  'sentNote',
  'sentSource',
  'sentDeliveryId',
  'sentManualPrior',
] as const;

export type InvoiceSentState = Pick<VorgangInvoice, (typeof INVOICE_SENT_STATE_KEYS)[number]>;

export function readInvoiceSentState(invoice: VorgangInvoice): InvoiceSentState {
  const state: Record<string, unknown> = {};
  for (const key of INVOICE_SENT_STATE_KEYS) {
    if (invoice[key] !== undefined) state[key] = invoice[key];
  }
  return state as InvoiceSentState;
}

/** Setzt genau die Versandfelder; fehlende werden entfernt, alles andere bleibt. */
export function applyInvoiceSentState(invoice: VorgangInvoice, state: InvoiceSentState): VorgangInvoice {
  const next: Record<string, unknown> = { ...invoice };
  for (const key of INVOICE_SENT_STATE_KEYS) {
    const value = state[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as VorgangInvoice;
}

/**
 * Der Versandstand, den das Gerät eines Mitglieds übernehmen muss, oder `null`.
 *
 *  - Die Cloud trägt einen vollständigen Versand: Er gilt, Herkunft und
 *    E-Mail-Bezug des Geräts bleiben stehen.
 *  - Die Cloud ist eindeutig unversendet (`vorbereitet`): Ein manueller lokaler
 *    Vermerk wird zurückgenommen. Ein Versand über OfficeTakt bleibt — ihn setzt
 *    ohnehin nur der Server.
 *  - Alles andere (unvollständiger oder unbekannter Cloud-Stand) bleibt, wie es
 *    ist: ohne Beweis keine Änderung.
 */
export function resolveMemberInvoiceSentTarget(
  local: VorgangInvoice,
  cloud: { snapshot: InvoiceSentSnapshot | null; status: string | null | undefined },
): InvoiceSentState | null {
  if (cloud.snapshot) {
    if (local.status === 'versendet' && sentSnapshotsEqual(readInvoiceSentSnapshot(local), cloud.snapshot)) {
      return null;
    }
    return {
      ...readInvoiceSentState(local),
      status: 'versendet',
      sentAt: cloud.snapshot.sentAt,
      sentVia: cloud.snapshot.sentVia,
      sentNote: cloud.snapshot.sentNote,
    };
  }
  if (local.status !== 'versendet' || cloud.status !== 'vorbereitet') return null;
  if (local.sentSource === 'officepilot') return null;
  return { status: 'vorbereitet' };
}

/**
 * Pull: eine Rechnung auf dem Gerät eines Mitglieds an ihre Cloud-Zeile
 * angleichen. `null` heißt: nichts weicht ab.
 *
 * Die Bestätigung des Leistungszeitraums fällt dabei auf `false` und nicht auf
 * „fehlt": Der monotone Merge hebt sie wieder an, sobald Inhaber oder
 * Verwaltung bestätigt haben, und bis dahin sperrt der PDF-Pfad.
 */
export function alignInvoiceFactsForMember(local: VorgangInvoice, cloud: VorgangInvoice): VorgangInvoice | null {
  let next: VorgangInvoice | null = null;
  const sentTarget = resolveMemberInvoiceSentTarget(local, {
    snapshot: readInvoiceSentSnapshot(cloud),
    status: cloud.status,
  });
  if (sentTarget) next = applyInvoiceSentState(local, sentTarget);
  if (local.servicePeriodConfirmed === true && cloud.servicePeriodConfirmed !== true) {
    next = { ...(next ?? local), servicePeriodConfirmed: false };
  }
  return next;
}
