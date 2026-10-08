/**
 * P1 MITARBEITERZAHLUNGEN — Mitarbeiter-Stammsatz.
 *
 * Bewusst schmal: Name, optional Personalnummer, aktiv/inaktiv. Keine
 * Personalakte, keine Anschrift, kein Konto, keine Verbindung zu einem
 * Benutzerkonto. Gelöscht wird nie — ein Mitarbeiter mit Zahlungshistorie
 * bleibt als Bezug erhalten und wird nur deaktiviert.
 */
import type { Employee } from '../../types/employee';
import { getSyncClient } from '../sync/syncClientService';
import { generateUuid } from '../sync/syncMetaService';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
import { persistAll } from '../persistenceService';
import {
  getEmployeeFromStore,
  getEmployeeStoreSnapshot,
  putEmployeeInStore,
} from './employeeStore';

export const EMPLOYEE_NAME_MAX_LENGTH = 120;
export const EMPLOYEE_PERSONNEL_NUMBER_MAX_LENGTH = 40;

export type EmployeeMutationResult =
  | { success: true; employee: Employee }
  | { success: false; errorKey: string };

export interface EmployeeActor {
  userId?: string;
}

export function listEmployees(options: { includeInactive?: boolean } = {}): Employee[] {
  const includeInactive = options.includeInactive ?? true;
  return getEmployeeStoreSnapshot()
    .filter((employee) => includeInactive || employee.active)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export function getEmployeeById(id: string): Employee | undefined {
  return getEmployeeFromStore(id);
}

function normalizeName(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeNumber(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function validate(name: string, personnelNumber: string, ownId?: string): string | null {
  if (!name) return 'employee.error.nameRequired';
  if (name.length > EMPLOYEE_NAME_MAX_LENGTH) return 'employee.error.nameTooLong';
  if (personnelNumber.length > EMPLOYEE_PERSONNEL_NUMBER_MAX_LENGTH) return 'employee.error.personnelNumberTooLong';
  if (personnelNumber) {
    const taken = getEmployeeStoreSnapshot().some(
      (other) =>
        other.id !== ownId &&
        (other.personnelNumber ?? '').toLocaleLowerCase('de') === personnelNumber.toLocaleLowerCase('de'),
    );
    if (taken) return 'employee.error.personnelNumberTaken';
  }
  return null;
}

function enqueue(employee: Employee): void {
  const version = employee.sync?.version ?? 0;
  enqueueSyncOutbox({
    entityType: 'employee',
    entityId: employee.id,
    operation: version === 0 ? 'create' : 'update',
    version,
  });
}

export function createEmployee(
  input: { name: string; personnelNumber?: string },
  actor: EmployeeActor = {},
): EmployeeMutationResult {
  const name = normalizeName(input.name);
  const personnelNumber = normalizeNumber(input.personnelNumber);
  const errorKey = validate(name, personnelNumber);
  if (errorKey) return { success: false, errorKey };

  const now = new Date().toISOString();
  const client = getSyncClient();
  const employee = putEmployeeInStore({
    id: generateUuid(),
    name,
    ...(personnelNumber ? { personnelNumber } : {}),
    active: true,
    createdAt: now,
    ...(actor.userId ? { createdBy: actor.userId } : {}),
    updatedAt: now,
    ...(actor.userId ? { updatedBy: actor.userId } : {}),
    // Basisversion 0: noch nie vom Server bestätigt.
    sync: {
      updatedAt: now,
      version: 0,
      deleted: false,
      deviceId: client.deviceId,
      workspaceId: client.workspaceId,
    },
  });
  enqueue(employee);
  persistAll();
  return { success: true, employee };
}

export function updateEmployee(
  id: string,
  changes: { name?: string; personnelNumber?: string | null },
  actor: EmployeeActor = {},
): EmployeeMutationResult {
  const current = getEmployeeFromStore(id);
  if (!current) return { success: false, errorKey: 'employee.error.notFound' };
  const name = changes.name === undefined ? current.name : normalizeName(changes.name);
  const personnelNumber =
    changes.personnelNumber === undefined ? current.personnelNumber ?? '' : normalizeNumber(changes.personnelNumber);
  const errorKey = validate(name, personnelNumber, id);
  if (errorKey) return { success: false, errorKey };
  if (name === current.name && personnelNumber === (current.personnelNumber ?? '')) {
    return { success: true, employee: current };
  }
  const now = new Date().toISOString();
  const { personnelNumber: _alt, ...ohneNummer } = current;
  void _alt;
  const employee = putEmployeeInStore({
    ...ohneNummer,
    name,
    ...(personnelNumber ? { personnelNumber } : {}),
    updatedAt: now,
    ...(actor.userId ? { updatedBy: actor.userId } : {}),
  });
  enqueue(employee);
  persistAll();
  return { success: true, employee };
}

export function setEmployeeActive(id: string, active: boolean, actor: EmployeeActor = {}): EmployeeMutationResult {
  const current = getEmployeeFromStore(id);
  if (!current) return { success: false, errorKey: 'employee.error.notFound' };
  if (current.active === active) return { success: true, employee: current };
  const employee = putEmployeeInStore({
    ...current,
    active,
    updatedAt: new Date().toISOString(),
    ...(actor.userId ? { updatedBy: actor.userId } : {}),
  });
  enqueue(employee);
  persistAll();
  return { success: true, employee };
}
