import type { CustomerBilling } from '../../types/models';

/**
 * CUSTOMER-SNAPSHOT-FIELD-CATALOG-04B — die erlaubten Schlüssel des
 * `customerSnapshot` einer Rechnung. Eine Quelle, zwei Validatoren.
 *
 * Genau wie beim Firmen-Snapshot (`companySnapshotFieldCatalog`) standen die
 * Kundenschlüssel bisher zweimal da: einmal im Cloud-Payload-Validator, einmal
 * im Prepared-Finalize-Request-Validator. Beim Firmenblock ist dieser Aufbau
 * bereits einmal auseinandergelaufen — die eine Liste wurde ergänzt, die
 * andere nicht, und jede Freigabe scheiterte danach mit `unknown_field`.
 * Bevor 04B vier neue Schlüssel einträgt, bekommt auch der Kundenblock seine
 * eine Quelle.
 *
 * Hier steht **ausschliesslich** der Schlüsselvertrag. Keine Typregeln, keine
 * Fehlercodes, keine Pflicht-/Optionalunterscheidung: Die beiden Validatoren
 * prüfen fachlich verschieden — der eine meldet `not_text`, der andere
 * `not_string` — und das bleibt bewusst so.
 *
 * Rein: kein React, keine Cloud, kein Zustand.
 */
export const CUSTOMER_SNAPSHOT_KEYS = [
  'name',
  'contactPerson',
  'street',
  'zip',
  'city',
  'email',
  'phone',
  // E-RECHNUNG-04B — was eine E-Rechnung vom Empfänger wissen muss.
  'countryCode',
  'vatId',
  'buyerReference',
  'leitwegId',
] as const satisfies readonly (keyof CustomerBilling)[];

export type CustomerSnapshotKey = (typeof CUSTOMER_SNAPSHOT_KEYS)[number];

/**
 * Die Schlüssel, die eine Rechnung aus der Zeit vor 04B **nicht** trägt.
 *
 * Sie sind deshalb optional zu prüfen: Ein Altbeleg ohne `countryCode` ist
 * kein fehlerhafter Beleg, sondern einer aus einer Zeit, in der das Feld nicht
 * existierte. Er wird ausdrücklich **nicht** nachträglich angereichert; ob er
 * sich als E-Rechnung ausgeben lässt, entscheidet später 04C.
 */
export const CUSTOMER_SNAPSHOT_OPTIONAL_KEYS = [
  'countryCode',
  'vatId',
  'buyerReference',
  'leitwegId',
] as const satisfies readonly CustomerSnapshotKey[];

const OPTIONAL = new Set<string>(CUSTOMER_SNAPSHOT_OPTIONAL_KEYS);

/** Muss dieser Schlüssel in jedem Kundensnapshot stehen? */
export function isRequiredCustomerSnapshotKey(key: string): boolean {
  return !OPTIONAL.has(key);
}
