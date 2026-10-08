/**
 * P1 MITARBEITERZAHLUNGEN — der lokale Spiegel von Mitarbeitern und
 * Mitarbeiterzahlungen. Reiner Speicher ohne Fachlogik und ohne Persistenz;
 * geschrieben wird ausschliesslich über die Dienste.
 */
import type { Employee, EmployeePayment, EmployeePaymentKind, EmployeePaymentMethod } from '../../types/employee';
import { EMPLOYEE_PAYMENT_KINDS, EMPLOYEE_PAYMENT_METHODS } from '../../types/employee';

let employees: Employee[] = [];
let payments: EmployeePayment[] = [];

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeEmployee(raw: Employee): Employee {
  const now = new Date().toISOString();
  const personnelNumber = text(raw.personnelNumber);
  const createdBy = text(raw.createdBy);
  const updatedBy = text(raw.updatedBy);
  return {
    id: String(raw.id),
    name: text(raw.name) ?? '',
    ...(personnelNumber ? { personnelNumber } : {}),
    active: raw.active !== false,
    createdAt: text(raw.createdAt) ?? now,
    ...(createdBy ? { createdBy } : {}),
    updatedAt: text(raw.updatedAt) ?? text(raw.createdAt) ?? now,
    ...(updatedBy ? { updatedBy } : {}),
    ...(raw.sync ? { sync: { ...raw.sync } } : {}),
  };
}

export function normalizeEmployeePayment(raw: EmployeePayment): EmployeePayment {
  const kind: EmployeePaymentKind = EMPLOYEE_PAYMENT_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const method: EmployeePaymentMethod = EMPLOYEE_PAYMENT_METHODS.includes(raw.paymentMethod)
    ? raw.paymentMethod
    : 'other';
  const optional = (key: keyof EmployeePayment) => {
    const value = text(raw[key]);
    return value ? { [key]: value } : {};
  };
  return {
    id: String(raw.id),
    employeeId: String(raw.employeeId),
    employeeName: text(raw.employeeName) ?? '',
    ...optional('personnelNumber'),
    kind,
    amount: Math.round(Number(raw.amount) * 100) / 100,
    paymentDate: String(raw.paymentDate),
    paymentMethod: method,
    ...(kind === 'wage' ? optional('wageMonth') : {}),
    ...optional('purpose'),
    ...optional('note'),
    receiptReference: String(raw.receiptReference ?? ''),
    ...optional('paidByName'),
    ...optional('receiptDocumentId'),
    ...optional('proofDocumentId'),
    createdAt: text(raw.createdAt) ?? new Date().toISOString(),
    ...optional('createdBy'),
    ...optional('reversedAt'),
    ...optional('reversedBy'),
    ...optional('reversalReason'),
  };
}

export function hydrateEmployeeStore(items: Employee[] | undefined): void {
  employees = (items ?? []).map(normalizeEmployee);
}

export function hydrateEmployeePaymentStore(items: EmployeePayment[] | undefined): void {
  payments = (items ?? []).map(normalizeEmployeePayment);
}

export function resetEmployeeStores(): void {
  employees = [];
  payments = [];
}

export function getEmployeeStoreSnapshot(): Employee[] {
  return employees.map(normalizeEmployee);
}

export function getEmployeePaymentStoreSnapshot(): EmployeePayment[] {
  return payments.map(normalizeEmployeePayment);
}

export function getEmployeeFromStore(id: string): Employee | undefined {
  const found = employees.find((item) => item.id === id);
  return found ? normalizeEmployee(found) : undefined;
}

export function getEmployeePaymentFromStore(id: string): EmployeePayment | undefined {
  const found = payments.find((item) => item.id === id);
  return found ? normalizeEmployeePayment(found) : undefined;
}

export function putEmployeeInStore(next: Employee): Employee {
  const normalized = normalizeEmployee(next);
  const index = employees.findIndex((item) => item.id === normalized.id);
  employees =
    index === -1
      ? [...employees, normalized]
      : [...employees.slice(0, index), normalized, ...employees.slice(index + 1)];
  return normalizeEmployee(normalized);
}

export function putEmployeePaymentInStore(next: EmployeePayment): EmployeePayment {
  const normalized = normalizeEmployeePayment(next);
  const index = payments.findIndex((item) => item.id === normalized.id);
  payments =
    index === -1
      ? [normalized, ...payments]
      : [...payments.slice(0, index), normalized, ...payments.slice(index + 1)];
  return normalizeEmployeePayment(normalized);
}
