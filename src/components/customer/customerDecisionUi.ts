/**
 * CUSTOMER-FACHOBJEKT-04C — shared UI rules for the customer decision.
 *
 * Pure helpers so the Vorgang dialog and the contract accept surface cannot
 * drift apart. No React state, no store mutation, no service call besides the
 * read-only customer snapshot.
 */
import { isOwnCompanyName } from '../../services/customerOwnCompanyGuard';
import { getCustomerStoreSnapshot } from '../../services/customerStoreService';
import type { CustomerDecision } from '../../services/customerService';
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

/** Builds the call contract; null when the current state is not decidable. */
export function buildCustomerDecisionFromUi(
  mode: CustomerDecisionMode | null,
  name: string,
  selectedCustomerId: string | null,
): CustomerDecision | null {
  if (mode === 'new') {
    if (resolveNewCustomerHintKey(mode, name)) return null;
    return { kind: 'new', input: { name } };
  }
  if (mode === 'existing') {
    if (!selectedCustomerId) return null;
    return { kind: 'existing', customerId: selectedCustomerId };
  }
  if (mode === 'none') return { kind: 'none' };
  return null;
}
