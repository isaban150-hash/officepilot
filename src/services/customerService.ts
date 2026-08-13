/**
 * CUSTOMER-FACHOBJEKT-02A — customer mutations with persistence and rollback.
 *
 * Deliberately not connected to Vorgang, Inbox, documents or UI in this sprint.
 * No name-based merging: two customers may share a name and stay separate.
 */
import { isOwnCompanyName } from './customerOwnCompanyGuard';
import {
  cloneCustomer,
  getCustomerById,
  getCustomerStoreSnapshot,
  restoreCustomerStore,
  upsertCustomerInStore,
} from './customerStoreService';
import { persistAll } from './persistenceService';
import { generateEntityId } from './sync/syncMetaService';
import type { Customer, CustomerBilling } from '../types/models';

export type CustomerMutationResult =
  | { success: true; customer: Customer }
  | { success: false; errorKey: string };

export type CustomerInput = Partial<CustomerBilling> & Pick<CustomerBilling, 'name'>;

function text(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function createCustomer(
  input: CustomerInput,
  options?: { createdFromInboxId?: string },
): CustomerMutationResult {
  const name = text(input.name);
  if (!name) return { success: false, errorKey: 'customer.nameRequired' };
  if (isOwnCompanyName(name)) return { success: false, errorKey: 'customer.ownCompanyNotAllowed' };

  const now = new Date().toISOString();
  const customer: Customer = {
    id: generateEntityId('cust'),
    name,
    contactPerson: text(input.contactPerson),
    street: text(input.street),
    zip: text(input.zip),
    city: text(input.city),
    email: text(input.email),
    phone: text(input.phone),
    createdAt: now,
    updatedAt: now,
  };
  const createdFromInboxId = text(options?.createdFromInboxId);
  if (createdFromInboxId) customer.createdFromInboxId = createdFromInboxId;

  const previous = getCustomerStoreSnapshot();
  upsertCustomerInStore(customer);

  const persisted = persistAll();
  if (!persisted.success) {
    restoreCustomerStore(previous);
    return { success: false, errorKey: 'customer.persistFailed' };
  }

  return { success: true, customer: cloneCustomer(customer) };
}

export function updateCustomer(
  customerId: string,
  changes: Partial<CustomerBilling>,
): CustomerMutationResult {
  const current = getCustomerById(customerId);
  if (!current) return { success: false, errorKey: 'customer.notFound' };

  const nextName = changes.name === undefined ? current.name : text(changes.name);
  if (!nextName) return { success: false, errorKey: 'customer.nameRequired' };
  if (isOwnCompanyName(nextName)) {
    return { success: false, errorKey: 'customer.ownCompanyNotAllowed' };
  }

  // id, createdAt and createdFromInboxId are provenance — never taken from changes.
  const updated: Customer = {
    ...current,
    name: nextName,
    contactPerson:
      changes.contactPerson === undefined ? current.contactPerson : text(changes.contactPerson),
    street: changes.street === undefined ? current.street : text(changes.street),
    zip: changes.zip === undefined ? current.zip : text(changes.zip),
    city: changes.city === undefined ? current.city : text(changes.city),
    email: changes.email === undefined ? current.email : text(changes.email),
    phone: changes.phone === undefined ? current.phone : text(changes.phone),
    updatedAt: new Date().toISOString(),
  };

  const previous = getCustomerStoreSnapshot();
  upsertCustomerInStore(updated);

  const persisted = persistAll();
  if (!persisted.success) {
    restoreCustomerStore(previous);
    return { success: false, errorKey: 'customer.persistFailed' };
  }

  return { success: true, customer: cloneCustomer(updated) };
}

export { getCustomerById, getCustomerStoreSnapshot } from './customerStoreService';
