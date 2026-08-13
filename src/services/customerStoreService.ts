/**
 * CUSTOMER-FACHOBJEKT-02A — pure in-memory customer store.
 *
 * No persistence, no validation, no other service imports. Mutations are
 * driven by customerService, which owns persistAll and rollback.
 */
import type { Customer } from '../types/models';

let customers: Customer[] = [];

export function cloneCustomer(customer: Customer): Customer {
  return { ...customer };
}

export function getCustomerStoreSnapshot(): Customer[] {
  return customers.map(cloneCustomer);
}

export function getCustomerById(id: string): Customer | undefined {
  const found = customers.find((customer) => customer.id === id);
  return found ? cloneCustomer(found) : undefined;
}

export function hydrateCustomerStore(list: Customer[]): void {
  customers = list.map(cloneCustomer);
}

export function resetCustomers(): void {
  customers = [];
}

/** Append or replace by id. Used only by customerService. */
export function upsertCustomerInStore(customer: Customer): void {
  const index = customers.findIndex((entry) => entry.id === customer.id);
  const next = cloneCustomer(customer);
  customers =
    index === -1
      ? [...customers, next]
      : [...customers.slice(0, index), next, ...customers.slice(index + 1)];
}

/** Restores a previously captured snapshot after a failed persist. */
export function restoreCustomerStore(previous: Customer[]): void {
  customers = previous.map(cloneCustomer);
}
