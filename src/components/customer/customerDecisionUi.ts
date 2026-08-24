/**
 * CUSTOMER-FACHOBJEKT-04C — shared UI rules for the customer decision.
 *
 * Pure helpers so the Vorgang dialog and the contract accept surface cannot
 * drift apart. No React state, no store mutation, no service call besides the
 * read-only customer snapshot.
 */
import { isOwnCompanyName } from '../../services/customerOwnCompanyGuard';
import { getCustomerStoreSnapshot } from '../../services/customerStoreService';
import type { CustomerDecision, CustomerInput } from '../../services/customerService';
import type { BusinessStructuredParty } from '../../types/businessInterpretation';
import type { Customer } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import type { CustomerDecisionMode } from './CustomerDecisionChoice';

/** Selectable customers: no empty names, never the own company, deterministic order. */
export function loadSelectableCustomers(): Customer[] {
  return getCustomerStoreSnapshot()
    .filter((customer) => customer.name.trim() && !isOwnCompanyName(customer.name))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'de') ||
        a.city.localeCompare(b.city, 'de') ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/**
 * Static validation for mode 'new'. Returns the translation key of the reason,
 * or null when nothing blocks. Derived from state so it is visible while the
 * confirm button is still disabled.
 */
export function resolveNewCustomerHintKey(
  mode: CustomerDecisionMode | null,
  name: string,
): TranslationKey | null {
  if (mode !== 'new') return null;
  const trimmed = name.trim();
  if (!trimmed) return 'customerDecision.nameRequired';
  if (isOwnCompanyName(trimmed)) return 'customerDecision.ownCompany';
  return null;
}

/** True when the confirm action must stay disabled. */
export function isCustomerDecisionIncomplete(
  mode: CustomerDecisionMode | null,
  name: string,
  selectedCustomerId: string | null,
): boolean {
  if (mode === null) return true;
  if (mode === 'new') return resolveNewCustomerHintKey(mode, name) !== null;
  if (mode === 'existing') return !selectedCustomerId;
  return false;
}

/**
 * CUSTOMER-FACHOBJEKT-05C — the six optional master data fields of a new
 * customer. The name is never held here; it stays in each parent's existing
 * single source.
 */
export interface CustomerExtraFields {
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  phone: string;
}

/** A fresh object per call — never a shared mutable constant. */
export function createEmptyCustomerExtraFields(): CustomerExtraFields {
  return {
    contactPerson: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
  };
}

/**
 * CUSTOMER-PREFILL-FROM-DOCUMENT-01B — turns the recognised counterparty into a
 * prefill proposal for the "Neuer Kunde" form.
 *
 * The single input is the structured counterparty, independent of document
 * type: no `kind === 'werkvertrag'` branch, no order proposal. Fields the
 * document does not state (typically e-mail and phone) stay empty rather than
 * being guessed, and no counterparty at all yields the same empty form as
 * before.
 */
export function buildCustomerExtraFromParty(
  party: BusinessStructuredParty | undefined,
): CustomerExtraFields {
  const extra = createEmptyCustomerExtraFields();
  if (!party || party.relation !== 'counterparty') return extra;
  return {
    ...extra,
    contactPerson: party.contactPerson?.trim() ?? '',
    street: party.street?.trim() ?? '',
    zip: party.zip?.trim() ?? '',
    city: party.city?.trim() ?? '',
    email: party.email?.trim() ?? '',
    phone: party.phone?.trim() ?? '',
  };
}

/** Joins the existing name source with the six optional fields. */
export function buildCustomerInputFromUi(
  name: string,
  extra: CustomerExtraFields,
): CustomerInput {
  return { name, ...extra };
}

/** Builds the call contract; null when the current state is not decidable. */
export function buildCustomerDecisionFromUi(
  mode: CustomerDecisionMode | null,
  input: CustomerInput,
  selectedCustomerId: string | null,
): CustomerDecision | null {
  if (mode === 'new') {
    if (resolveNewCustomerHintKey(mode, input.name)) return null;
    // A copy, so later typing cannot reach an already built decision.
    return { kind: 'new', input: { ...input } };
  }
  if (mode === 'existing') {
    if (!selectedCustomerId) return null;
    return { kind: 'existing', customerId: selectedCustomerId };
  }
  if (mode === 'none') return { kind: 'none' };
  return null;
}
