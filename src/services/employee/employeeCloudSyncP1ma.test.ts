/**
 * P1 MITARBEITERZAHLUNGEN — Cloud-Abgleich der Mitarbeiter und Zahlungen.
 *
 * Der Server ist hier ein Aufzeichner: Jeder RPC-Aufruf wird mitgeschrieben
 * und beantwortet, wie es der SQL-Vertrag tut. Geprüft werden Reihenfolge,
 * Idempotenz der Zahlungsschritte, die Übernahme auf ein frisches Gerät
 * (Client B) und die Zusammenführung, die keine lokale Tatsache verliert.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_PUSH_ORDER,
  applyEmployeePullToState,
  classifyEmployeeCloudErrorForTests,
  collectDirtyEmployeeKeys,
  mergeEmployeeDataFromPull,
  pushEmployeeEntity,
  type CloudEmployeePaymentRow,
  type CloudEmployeeRow,
} from './employeeCloudSyncService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import type { Employee, EmployeePayment } from '../../types/employee';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = '00000000-0000-4000-8000-00000000e1d1';
const CONTEXT = { deviceId: 'dev-b', workspaceId: 'local-ws-b', dirty: new Set<string>() };

interface Aufruf {
  name: string;
  params: Record<string, unknown>;
}

function server(antworten: Record<string, { data?: unknown; error?: { message: string; code?: string } }> = {}) {
  const aufrufe: Aufruf[] = [];
  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      aufrufe.push({ name, params });
      return antworten[name] ?? { data: { replayed: false }, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, aufrufe };
}

function mitarbeiter(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    name: 'Erika Beispiel',
    personnelNumber: 'P-01',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    sync: { updatedAt: '2026-10-01T08:00:00.000Z', version: 0, deleted: false, deviceId: 'dev-a', workspaceId: 'local-ws-a' },
    ...overrides,
  };
}

function zahlung(overrides: Partial<EmployeePayment> = {}): EmployeePayment {
  return {
    id: 'pay-1',
    employeeId: 'emp-1',
    employeeName: 'Erika Beispiel',
    kind: 'wage',
    amount: 800,
    paymentDate: '2026-10-02',
    paymentMethod: 'cash',
    receiptReference: 'MZ-20261002-ABCD2345',
    createdAt: '2026-10-02T09:00:00.000Z',
    ...overrides,
  };
}

function mitarbeiterZeile(overrides: Partial<CloudEmployeeRow> = {}): CloudEmployeeRow {
  return {
    client_employee_id: 'emp-1',
    name: 'Erika Beispiel',
    personnel_number: 'P-01',
    active: true,
    row_version: 1,
    created_at: '2026-10-01T08:00:01.000Z',
    updated_at: '2026-10-01T08:00:01.000Z',
    ...overrides,
  };
}

function zahlungsZeile(overrides: Partial<CloudEmployeePaymentRow> = {}): CloudEmployeePaymentRow {
  return {
    client_payment_id: 'pay-1',
    client_employee_id: 'emp-1',
    employee_name: 'Erika Beispiel',
    personnel_number: null,
    kind: 'wage',
    amount: '800.00',
    paid_on: '2026-10-02',
    method: 'cash',
    wage_month: null,
    purpose: null,
    note: null,
    receipt_reference: 'MZ-20261002-ABCD2345',
    paid_by_name: null,
    receipt_document_id: null,
    proof_document_id: null,
    created_at: '2026-10-02T09:00:01.000Z',
    reversed_at: null,
    reversal_reason: null,
    ...overrides,
  };
}

describe('Push — Reihenfolge und Idempotenz', () => {
  it('Mitarbeiter vor Zahlung', () => {
    expect(EMPLOYEE_PUSH_ORDER.employee).toBeLessThan(EMPLOYEE_PUSH_ORDER.employee_payment);
  });

  it('ein Mitarbeiter geht mit der zuletzt bestätigten Basisversion an den Server', async () => {
    const { client, aufrufe } = server({ upsert_workspace_employee: { data: { row_version: 1, replayed: false } } });
    const ergebnis = await pushEmployeeEntity(
      { entityType: 'employee', entityId: 'emp-1', entity: mitarbeiter(), rowVersion: 0, deleted: false },
      'create',
      WS,
      client,
    );
    expect(ergebnis).toEqual({ kind: 'pushed', rowVersion: 1 });
    expect(aufrufe).toEqual([
      {
        name: 'upsert_workspace_employee',
        params: {
          p_workspace_id: WS,
          p_payload: { client_employee_id: 'emp-1', name: 'Erika Beispiel', personnel_number: 'P-01', active: true },
          p_row_version: 0,
        },
      },
    ]);
  });

  it('eine Zahlung: anlegen, Quittung, Nachweis, Storno — in dieser Reihenfolge, mit unveränderter Referenz', async () => {
    const { client, aufrufe } = server();
    const voll = zahlung({
      receiptDocumentId: 'emp-receipt-pay-1',
      proofDocumentId: 'doc-unterschrieben',
      reversedAt: '2026-10-05T10:00:00.000Z',
      reversalReason: 'Doppelt erfasst',
    });
    const ergebnis = await pushEmployeeEntity(
      { entityType: 'employee_payment', entityId: 'pay-1', entity: voll, rowVersion: 0, deleted: false },
      'update',
      WS,
      client,
    );
    expect(ergebnis.kind).toBe('skipped');
    expect(aufrufe.map((aufruf) => aufruf.name)).toEqual([
      'add_workspace_employee_payment',
      'set_workspace_employee_payment_receipt',
      'set_workspace_employee_payment_proof',
      'reverse_workspace_employee_payment',
    ]);
    expect(aufrufe[0].params).toMatchObject({
      p_workspace_id: WS,
      p_client_payment_id: 'pay-1',
      p_client_employee_id: 'emp-1',
      p_amount: 800,
      p_paid_on: '2026-10-02',
      p_method: 'cash',
      p_kind: 'wage',
      p_receipt_reference: 'MZ-20261002-ABCD2345',
    });
    expect(aufrufe[1].params).toMatchObject({ p_client_document_id: 'emp-receipt-pay-1' });
    expect(aufrufe[2].params).toMatchObject({ p_client_document_id: 'doc-unterschrieben' });
    expect(aufrufe[3].params).toMatchObject({ p_reason: 'Doppelt erfasst' });
  });

  it('eine einfache Zahlung ohne Belege ruft keinen Storno und keine Quittung auf', async () => {
    const { client, aufrufe } = server();
    await pushEmployeeEntity(
      { entityType: 'employee_payment', entityId: 'pay-1', entity: zahlung(), rowVersion: 0, deleted: false },
      'create',
      WS,
      client,
    );
    expect(aufrufe.map((aufruf) => aufruf.name)).toEqual(['add_workspace_employee_payment', 'set_workspace_employee_payment_proof']);
  });

  it('ein Serverfehler wird eingeordnet: Recht und Konflikt endgültig, Netz und fehlender Stammsatz wiederholbar', async () => {
    const finanz = classifyEmployeeCloudErrorForTests({ message: 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht' });
    expect([finanz.code, finanz.retryable]).toEqual(['rls', false]);
    const konflikt = classifyEmployeeCloudErrorForTests({ message: 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten' });
    expect([konflikt.code, konflikt.retryable]).toEqual(['version_conflict', false]);
    const version = classifyEmployeeCloudErrorForTests({ message: 'Versionskonflikt employee:3' });
    expect([version.code, version.retryable]).toEqual(['version_conflict', false]);
    const quittung = classifyEmployeeCloudErrorForTests({ message: 'Quittung bereits gesetzt' });
    expect(quittung.retryable).toBe(false);
    const netz = classifyEmployeeCloudErrorForTests({ message: 'Failed to fetch' });
    expect([netz.code, netz.retryable]).toEqual(['network', true]);
    const fehlt = classifyEmployeeCloudErrorForTests({ message: 'Mitarbeiter nicht gefunden' });
    expect(fehlt.retryable).toBe(true);
    const kein = classifyEmployeeCloudErrorForTests({ message: 'Kein Zugriff', code: '42501' });
    expect([kein.code, kein.retryable]).toEqual(['rls', false]);

    const { client } = server({ add_workspace_employee_payment: { error: { message: 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten' } } });
    await expect(
      pushEmployeeEntity({ entityType: 'employee_payment', entityId: 'pay-1', entity: zahlung(), rowVersion: 0, deleted: false }, 'create', WS, client),
    ).rejects.toMatchObject({ code: 'version_conflict', retryable: false });
  });

  it('die Nutzlast kommt aus dem lokalen Zustand', () => {
    const state = { employees: [mitarbeiter({ sync: { ...mitarbeiter().sync!, version: 3 } })], employeePayments: [zahlung()] } as unknown as AppPersistedState;
    expect(extractCloudSyncEntity(state, 'employee', 'emp-1')).toMatchObject({ entityType: 'employee', rowVersion: 3 });
    expect(extractCloudSyncEntity(state, 'employee_payment', 'pay-1')).toMatchObject({ entityType: 'employee_payment', entityId: 'pay-1' });
    expect(extractCloudSyncEntity(state, 'employee_payment', 'pay-unbekannt')).toBeNull();
  });
});

describe('Pull — frisches Gerät (Client B) und Zusammenführung', () => {
  it('Client B übernimmt Mitarbeiter und Zahlungen samt MZ-Referenz, Quittung, Nachweis und Storno', () => {
    const ergebnis = applyEmployeePullToState(
      {} as AppPersistedState,
      {
        employees: [mitarbeiterZeile({ row_version: 2, name: 'Erika Muster' })],
        payments: [
          zahlungsZeile({
            receipt_document_id: 'emp-receipt-pay-1',
            proof_document_id: 'doc-unterschrieben',
            reversed_at: '2026-10-05T10:00:00.000Z',
            reversal_reason: 'Doppelt erfasst',
          }),
        ],
      },
      CONTEXT,
    );
    expect(ergebnis.state.employees).toHaveLength(1);
    expect(ergebnis.state.employees![0]).toMatchObject({ name: 'Erika Muster', sync: { version: 2 } });
    expect(ergebnis.state.employeePayments![0]).toMatchObject({
      id: 'pay-1',
      amount: 800,
      receiptReference: 'MZ-20261002-ABCD2345',
      receiptDocumentId: 'emp-receipt-pay-1',
      proofDocumentId: 'doc-unterschrieben',
      reversedAt: '2026-10-05T10:00:00.000Z',
      reversalReason: 'Doppelt erfasst',
    });
    expect(ergebnis.backfill).toEqual([]);
  });

  it('verliert keine lokale Tatsache: ein lokaler Storno und eine lokale Quittung bleiben und werden nachgereicht', () => {
    const lokal = zahlung({
      reversedAt: '2026-10-05T10:00:00.000Z',
      reversalReason: 'Lokal storniert',
      receiptDocumentId: 'emp-receipt-pay-1',
    });
    const ergebnis = mergeEmployeeDataFromPull([mitarbeiter({ sync: { ...mitarbeiter().sync!, version: 1 } })], [lokal], {
      employees: [mitarbeiterZeile()],
      payments: [zahlungsZeile()],
    }, CONTEXT);
    expect(ergebnis.payments[0]).toMatchObject({ reversedAt: lokal.reversedAt, reversalReason: 'Lokal storniert', receiptDocumentId: 'emp-receipt-pay-1' });
    expect(ergebnis.backfill).toContainEqual({ entityType: 'employee_payment', entityId: 'pay-1', version: 1 });
  });

  it('übernimmt einen Storno und einen geänderten Nachweis aus der Cloud, wenn lokal nichts offen ist', () => {
    const ergebnis = mergeEmployeeDataFromPull([], [zahlung({ proofDocumentId: 'doc-alt' })], {
      employees: [],
      payments: [zahlungsZeile({ proof_document_id: 'doc-neu', reversed_at: '2026-10-06T10:00:00.000Z', reversal_reason: 'Anderes Gerät' })],
    }, CONTEXT);
    expect(ergebnis.payments[0]).toMatchObject({ proofDocumentId: 'doc-neu', reversedAt: '2026-10-06T10:00:00.000Z', reversalReason: 'Anderes Gerät' });
  });

  it('ein lokal offener Nachweis gewinnt und wird nicht doppelt eingereiht', () => {
    const dirty = new Set(['employee_payment:pay-1']);
    const ergebnis = mergeEmployeeDataFromPull([], [zahlung({ proofDocumentId: 'doc-lokal' })], {
      employees: [],
      payments: [zahlungsZeile({ proof_document_id: 'doc-cloud' })],
    }, { ...CONTEXT, dirty });
    expect(ergebnis.payments[0].proofDocumentId).toBe('doc-lokal');
    expect(ergebnis.backfill).toEqual([]);
  });

  it('die Geldfelder kommen aus der Cloud-Zeile; lokale Abweichungen werden nicht stillschweigend gerechnet', () => {
    const ergebnis = mergeEmployeeDataFromPull([], [zahlung({ amount: 900 })], { employees: [], payments: [zahlungsZeile()] }, CONTEXT);
    expect(ergebnis.payments[0].amount).toBe(800);
  });

  it('Mitarbeiter: neuer und lokal offen → Konflikt; neuer und sauber → übernehmen; nur lokal → nachreichen', () => {
    const offen = mergeEmployeeDataFromPull([mitarbeiter({ name: 'Lokal' })], [], { employees: [mitarbeiterZeile({ row_version: 2, name: 'Cloud' })], payments: [] }, {
      ...CONTEXT,
      dirty: new Set(['employee:emp-1']),
    });
    expect(offen.conflicts).toEqual(['employee:emp-1']);
    expect(offen.employees[0].name).toBe('Lokal');

    const sauber = mergeEmployeeDataFromPull([mitarbeiter({ name: 'Lokal' })], [], { employees: [mitarbeiterZeile({ row_version: 2, name: 'Cloud' })], payments: [] }, CONTEXT);
    expect(sauber.employees[0]).toMatchObject({ name: 'Cloud', sync: { version: 2 } });

    const nurLokal = mergeEmployeeDataFromPull([mitarbeiter({ id: 'emp-lokal' })], [zahlung({ id: 'pay-lokal', employeeId: 'emp-lokal' })], { employees: [], payments: [] }, CONTEXT);
    expect(nurLokal.backfill).toEqual([
      { entityType: 'employee', entityId: 'emp-lokal', version: 0 },
      { entityType: 'employee_payment', entityId: 'pay-lokal', version: 1 },
    ]);
  });

  it('offene Outbox-Aufträge markieren lokale Änderungen', () => {
    const outbox = [
      { id: 'o1', entityType: 'employee', entityId: 'emp-1', operation: 'update', version: 1, queuedAt: '', retryCount: 0, status: 'pending' },
      { id: 'o2', entityType: 'employee_payment', entityId: 'pay-1', operation: 'update', version: 1, queuedAt: '', retryCount: 0, status: 'completed' },
      { id: 'o3', entityType: 'expense', entityId: 'exp-1', operation: 'update', version: 1, queuedAt: '', retryCount: 0, status: 'pending' },
    ] as SyncOutboxEntry[];
    expect([...collectDirtyEmployeeKeys(outbox)]).toEqual(['employee:emp-1']);
  });
});

describe('Freischaltung erst mit Remote-Vertrag', () => {
  it('Mitarbeiter und Mitarbeiterzahlungen sind nach geprüfter Remote-Migration für den Cloud-Abgleich freigeschaltet', () => {
    /*
     * Umgestellt in der Abschlussphase: Die Migration 20261104120000 ist
     * remote angewendet und gegen die Datei geprüft. Erst damit öffnet die
     * Allowlist beide Typen — gemeinsam, denn eine Zahlung ohne ihren
     * Mitarbeiter liefe ins Leere.
     */
    expect(isSupabaseSyncAllowed('employee')).toBe(true);
    expect(isSupabaseSyncAllowed('employee_payment')).toBe(true);
  });
});
