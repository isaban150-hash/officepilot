/**
 * GO-LIVE-SECURITY-01 — verbindliche Ausgabe ohne Schreibrecht erst mit Nachweis.
 *
 * Geprüft werden die Regel, der Nachweisspeicher auf dem Gerät und seine
 * Quelle im Abzug. Inhaber, Verwaltung und der lokale Betrieb warten nie.
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VorgangInvoice } from '../../types/models';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import { applyInvoicePullAfterVorgangMerge } from './invoiceCloudPullOrchestrator';
import {
  hasServicePeriodCloudProof,
  recordServicePeriodCloudProofs,
  resetServicePeriodCloudProofsForTests,
  resolveInvoiceOutputHold,
} from './invoiceOutputClearance';

const SCHREIBEN = { canWrite: true };
const LESEN = { canWrite: false };

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  resetServicePeriodCloudProofsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetServicePeriodCloudProofsForTests();
});

describe('GLS01 Ausgabe — die Regel', () => {
  it('R1: Inhaber, Verwaltung und der lokale Betrieb warten nie', () => {
    for (const cloudCheckDone of [false, true]) {
      expect(
        resolveInvoiceOutputHold({ access: SCHREIBEN, localConfirmed: true, proven: false, cloudCheckDone }),
      ).toBeNull();
    }
  });

  it('R2: ohne Schreibrecht wartet eine lokale Bestätigung auf den Nachweis', () => {
    expect(
      resolveInvoiceOutputHold({ access: LESEN, localConfirmed: true, proven: false, cloudCheckDone: false }),
    ).toBe('verifying');
    expect(
      resolveInvoiceOutputHold({ access: LESEN, localConfirmed: true, proven: false, cloudCheckDone: true }),
    ).toBe('unverified');
    expect(
      resolveInvoiceOutputHold({ access: LESEN, localConfirmed: true, proven: true, cloudCheckDone: false }),
    ).toBeNull();
  });

  it('R3: ohne lokale Bestätigung sperrt schon der PDF-Validator, ein Halt kommt nicht hinzu', () => {
    expect(
      resolveInvoiceOutputHold({ access: LESEN, localConfirmed: false, proven: false, cloudCheckDone: false }),
    ).toBeNull();
  });
});

describe('GLS01 Ausgabe — der Nachweis auf dem Gerät', () => {
  it('N1: gilt je Betrieb und übersteht einen Neustart', () => {
    recordServicePeriodCloudProofs('ws-a', ['inv-1']);
    expect(hasServicePeriodCloudProof('ws-a', 'inv-1')).toBe(true);
    expect(hasServicePeriodCloudProof('ws-b', 'inv-1')).toBe(false);
    expect(hasServicePeriodCloudProof('ws-a', 'inv-2')).toBe(false);

    // Neustart: Der Arbeitsspeicher ist leer, es zählt nur noch das Gerät.
    resetServicePeriodCloudProofsForTests();
    expect(hasServicePeriodCloudProof('ws-a', 'inv-1')).toBe(true);
  });

  it('N2: ein unlesbarer oder fremder Eintrag ist kein Nachweis', () => {
    localStorage.setItem('officepilot-service-period-proof:ws-a', '{kaputt');
    expect(hasServicePeriodCloudProof('ws-a', 'inv-1')).toBe(false);
    localStorage.setItem('officepilot-service-period-proof:ws-c', JSON.stringify({ 'inv-1': true }));
    expect(hasServicePeriodCloudProof('ws-c', 'inv-1')).toBe(false);
  });

  it('N3: ist der Speicher voll, gilt der Nachweis für diese Sitzung', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    recordServicePeriodCloudProofs('ws-a', ['inv-1']);
    expect(hasServicePeriodCloudProof('ws-a', 'inv-1')).toBe(true);
  });

  it('N4: ohne Betrieb oder Rechnung gibt es keinen Nachweis', () => {
    recordServicePeriodCloudProofs('  ', ['inv-1']);
    expect(hasServicePeriodCloudProof('  ', 'inv-1')).toBe(false);
    expect(hasServicePeriodCloudProof('ws-a', ' ')).toBe(false);
  });
});

describe('GLS01 Ausgabe — Nachweis aus dem Abzug', () => {
  function zeile(invoice: VorgangInvoice, sequence: number) {
    return {
      id: `cloud-row-${invoice.id}`,
      workspace_id: 'ws-1',
      vorgang_id: 'v-test-1',
      client_invoice_id: invoice.id,
      invoice_number: invoice.number,
      invoice_year: 2026,
      invoice_sequence_number: sequence,
      invoice_type: invoice.type,
      invoice_status: 'vorbereitet',
      payload: { ...invoice },
      row_version: 1,
      created_at: '2026-07-23T10:00:00.000Z',
      updated_at: '2026-07-23T10:00:00.000Z',
    };
  }

  async function ziehe(alignForMember: boolean): Promise<void> {
    const bestaetigt = createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-cloud-bestaetigt',
      number: '2026-0001',
      invoiceSequenceNumber: 1,
      status: 'vorbereitet',
      servicePeriodConfirmed: true,
    });
    const offen = createAbschlagInvoice('op-test-1', 2, {
      id: 'inv-cloud-offen',
      number: '2026-0002',
      invoiceSequenceNumber: 2,
      status: 'vorbereitet',
    });
    delete offen.servicePeriodConfirmed;
    const client = {
      rpc: async (name: string) =>
        name === 'pull_workspace_invoices'
          ? { data: [zeile(bestaetigt, 1), zeile(offen, 2)], error: null }
          : { data: null, error: { message: 'im Test nicht vorgesehen' } },
    } as never;

    const result = await applyInvoicePullAfterVorgangMerge({
      workspaceId: 'ws-1',
      vorgaenge: [createTestVorgang({ invoices: [] })],
      report: createEmptySyncSimulationReport(),
      client,
      alignForMember,
    });
    expect(result.invoiceRpcFailed).toBe(false);
  }

  it('Z1: der Abzug auf dem Gerät eines Mitglieds vermerkt nur, was die Cloud bestätigt trägt', async () => {
    await ziehe(true);
    expect(hasServicePeriodCloudProof('ws-1', 'inv-cloud-bestaetigt')).toBe(true);
    expect(hasServicePeriodCloudProof('ws-1', 'inv-cloud-offen')).toBe(false);
  });

  it('Z2: auf dem Gerät von Inhaber und Verwaltung wird nichts vermerkt', async () => {
    await ziehe(false);
    expect(hasServicePeriodCloudProof('ws-1', 'inv-cloud-bestaetigt')).toBe(false);
    expect(localStorage.getItem('officepilot-service-period-proof:ws-1')).toBeNull();
  });
});
