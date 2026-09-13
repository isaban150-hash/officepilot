/**
 * CUSTOMER-IDENTITY-DUPLICATE-01A — Wiedererkennung wahrscheinlicher
 * Kundendubletten bei der Neuanlage.
 *
 * Eine Warnregel, keine Identitätsbehauptung: Sie sagt „das sieht ausreichend
 * ähnlich aus, der Nutzer muss entscheiden" — nie „das ist dieselbe Firma".
 * Deshalb wird hier nichts zusammengeführt, nichts ersetzt, keine ID
 * umgeschrieben. Die Entscheidung trifft der Nutzer (confirm-first), der
 * Service `createCustomer` / `validateCustomerDecisionForCreate` erzwingt sie
 * auf jedem Anlageweg.
 *
 * Signale (nur vorhandene Stammdaten, keine neuen Felder):
 *  - Name: normalisiert wie beim Own-Company-Guard (Rand, Leerraum, Schreibweise,
 *    Diakritika) — volle Gleichheit, kein Fuzzy Matching.
 *  - Anschrift: Straße + PLZ/Ort normalisiert (Leerraum, Satzzeichen,
 *    „str." ≙ „straße"). Nur „vollständig" (Straße und PLZ oder Ort) zählt als
 *    belastbares Signal.
 *  - Keine weiteren Kennungen: das Kundenmodell trägt keine USt-IdNr.; eine
 *    E-Mail-Adresse ist keine Firmenidentität (Niederlassungen teilen sie).
 *
 * Ergebnis:
 *  - strong: gleicher Name + gleiche vollständige Anschrift
 *  - weak:   gleicher Name, Anschrift auf mindestens einer Seite nicht belastbar
 *  - kein Kandidat: gleicher Name, aber beidseitig vollständige und verschiedene
 *    Anschrift — die Neuanlage bleibt frei (verschiedene Betriebe gleichen Namens).
 */
import { getCustomerStoreSnapshot } from '../customerStoreService';
import { isOwnCompanyName, normalizeCompanyNameForComparison } from '../customerOwnCompanyGuard';
import type { Customer, CustomerBilling } from '../../types/models';

export type CustomerDuplicateStrength = 'strong' | 'weak';
export type CustomerDuplicateReason = 'same_name' | 'same_address';

export interface CustomerDuplicateCandidate {
  customer: Customer;
  strength: CustomerDuplicateStrength;
  reasons: CustomerDuplicateReason[];
}

export type CustomerDuplicateInput = Partial<CustomerBilling> & Pick<CustomerBilling, 'name'>;

function text(value: string | undefined | null): string {
  return (value ?? '').trim();
}

/** Anschrift auf einen vergleichbaren Kern reduzieren; leer, wenn nicht belastbar. */
export function normalizeCustomerAddressForComparison(input: {
  street?: string;
  zip?: string;
  city?: string;
}): string {
  const street = normalizeCompanyNameForComparison(text(input.street))
    .replace(/str\.(?=\s|\d|$)/g, 'strasse')
    .replace(/straße|strasse/g, 'str')
    .replace(/[.,;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const zip = text(input.zip).replace(/\s+/g, '');
  const city = normalizeCompanyNameForComparison(text(input.city)).replace(/[.,;:]/g, '').trim();
  if (!street || (!zip && !city)) return '';
  return [street, zip, city].filter(Boolean).join('|');
}

/**
 * Wahrscheinliche Dubletten zu einer geplanten Neuanlage — sortiert: starke
 * Kandidaten zuerst, danach nach Anlagedatum. Die eigene Firma ist nie ein
 * Kandidat (sie ist nie ein Kunde); leere Namen liefern nichts.
 */
export function findCustomerDuplicateCandidates(
  input: CustomerDuplicateInput,
  customers: Customer[] = getCustomerStoreSnapshot(),
  options?: { excludeCustomerId?: string },
): CustomerDuplicateCandidate[] {
  const nameKey = normalizeCompanyNameForComparison(input.name);
  if (!nameKey || isOwnCompanyName(input.name)) return [];
  const addressKey = normalizeCustomerAddressForComparison(input);

  const candidates: CustomerDuplicateCandidate[] = [];
  for (const customer of customers) {
    if (options?.excludeCustomerId && customer.id === options.excludeCustomerId) continue;
    if (normalizeCompanyNameForComparison(customer.name) !== nameKey) continue;
    if (isOwnCompanyName(customer.name)) continue;

    const reasons: CustomerDuplicateReason[] = ['same_name'];
    const existingAddress = normalizeCustomerAddressForComparison(customer);

    if (addressKey && existingAddress) {
      if (addressKey === existingAddress) {
        reasons.push('same_address');
        candidates.push({ customer, strength: 'strong', reasons });
      }
      // beidseitig vollständig und verschieden: kein Kandidat
      continue;
    }

    candidates.push({ customer, strength: 'weak', reasons });
  }

  return candidates.sort(
    (a, b) =>
      (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1) ||
      a.customer.createdAt.localeCompare(b.customer.createdAt),
  );
}

/**
 * Starke Kandidaten sperren die Anlage im Dienst (jeder Anlageweg). Unsichere
 * Kandidaten (gleicher Name, Anschrift nicht belastbar) werden in der
 * Oberfläche zur Entscheidung gestellt, aber nicht im Dienst erzwungen — sonst
 * wäre ein zweiter Betrieb gleichen Namens ohne Anschrift nie anlegbar.
 */
export function findStrongCustomerDuplicateCandidates(
  input: CustomerDuplicateInput,
  customers?: Customer[],
): CustomerDuplicateCandidate[] {
  return findCustomerDuplicateCandidates(input, customers).filter((candidate) => candidate.strength === 'strong');
}

/** True, wenn die Neuanlage ohne bewusste Bestätigung nicht erfolgen darf. */
export function requiresCustomerDuplicateDecision(candidates: CustomerDuplicateCandidate[]): boolean {
  return candidates.length > 0;
}
