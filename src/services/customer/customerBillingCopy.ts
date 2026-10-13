/**
 * FINANZ-CORE-01A (KUN-01) — der Rechnungsempfänger vollständig, mit den
 * optionalen E-Rechnungsfeldern.
 *
 * Angebots- und Auftragseditor, Angebotsspeicher und Angebots-Sync kopierten
 * je nur die sieben Grundfelder. Land, USt-IdNr., Käuferreferenz und
 * Leitweg-ID gingen dabei verloren — eine Rechnung aus Angebot oder Auftrag
 * liess sich deshalb nicht als XRechnung ausgeben, auch nicht für öffentliche
 * Auftraggeber. Optionale Felder reisen wie in `billingFromCustomer` nur mit,
 * wenn sie gepflegt sind (keine leeren Platzhalter).
 */
import type { CustomerBilling } from '../../types/models';

const OPTIONAL_KEYS = ['countryCode', 'vatId', 'buyerReference', 'leitwegId'] as const;

export function copyCustomerBilling(
  customer: Partial<CustomerBilling> | undefined,
  options: { trim?: boolean } = {},
): CustomerBilling {
  const c = customer ?? {};
  const value = (raw: string | undefined) => (options.trim ? (raw ?? '').trim() : (raw ?? ''));
  const billing: CustomerBilling = {
    name: value(c.name),
    contactPerson: value(c.contactPerson),
    street: value(c.street),
    zip: value(c.zip),
    city: value(c.city),
    email: value(c.email),
    phone: value(c.phone),
  };
  for (const key of OPTIONAL_KEYS) {
    const raw = typeof c[key] === 'string' ? c[key]!.trim() : '';
    if (raw) billing[key] = raw;
  }
  return billing;
}

const BASE_KEYS = ['name', 'contactPerson', 'street', 'zip', 'city', 'email', 'phone'] as const;

/** FINANZ-CORE-01A (KUN-08) — alle Empfängerfelder in fester Reihenfolge (Rückfrage, Vergleich). */
export const CUSTOMER_BILLING_FIELDS = [...BASE_KEYS, ...OPTIONAL_KEYS] as const;
export type CustomerBillingField = (typeof CUSTOMER_BILLING_FIELDS)[number];

/** Die Felder, in denen zwei Empfängerstände voneinander abweichen. */
export function customerBillingDrift(
  draft: Partial<CustomerBilling> | undefined,
  master: Partial<CustomerBilling> | undefined,
): CustomerBillingField[] {
  const x = draft ?? {};
  const y = master ?? {};
  return CUSTOMER_BILLING_FIELDS.filter((key) => (x[key] ?? '').trim() !== (y[key] ?? '').trim());
}

/** Kennzeichen eines Paars (Entwurf, Stamm) — eine Zusage gilt nur für genau diesen Stand. */
export function customerDriftFingerprint(
  draft: Partial<CustomerBilling> | undefined,
  master: Partial<CustomerBilling> | undefined,
): string {
  return JSON.stringify([copyCustomerBilling(draft, { trim: true }), copyCustomerBilling(master, { trim: true })]);
}

/**
 * FINANZ-CORE-01A (KUN-04) — zwei Empfängerstände vollständig vergleichen, auch die
 * optionalen Felder.
 *
 * Bisher wurde nur über die Schlüssel des Kundenstamms verglichen. Ein im Stamm
 * gelöschtes Feld (etwa eine falsche USt-IdNr. oder Leitweg-ID) fehlt dort als
 * Schlüssel — der Entwurf trug es weiter, und „aus Kundenstamm übernehmen" meldete
 * „bereits aktuell". Abwesenheit und leerer Text gelten als gleich.
 */
export function sameCustomerBilling(
  a: Partial<CustomerBilling> | undefined,
  b: Partial<CustomerBilling> | undefined,
): boolean {
  const x = a ?? {};
  const y = b ?? {};
  return (
    BASE_KEYS.every((key) => (x[key] ?? '') === (y[key] ?? '')) &&
    OPTIONAL_KEYS.every((key) => (x[key] ?? '').trim() === (y[key] ?? '').trim())
  );
}
