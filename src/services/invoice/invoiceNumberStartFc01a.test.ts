/**
 * FINANZ-CORE-01A (RE-02) — die Startnummer aus der Einrichtung erreicht den
 * Server, und kein Ausgang außer einem Netzfehler sperrt die Freigabe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as workspaceSyncPayloadService from '../workspace/workspaceSyncPayloadService';
import { hydrateInvoiceNumberSequence, resetInvoiceNumberSequence } from '../invoiceNumberService';
import {
  ensureInvoiceNumberStartOnServer,
  resetInvoiceNumberStartForTests,
} from './invoiceNumberStartService';

const calls: Record<string, unknown>[] = [];
let antwort: () => { data: unknown; error: unknown } = () => ({ data: null, error: null });

beforeEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
  resetInvoiceNumberStartForTests();
  resetInvoiceNumberSequence();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args });
      return antwort();
    },
  } as never);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue({} as never);
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue('ws-start');
});

describe('RE-02 — Startnummer', () => {
  it('S1: ohne hinterlegte Startnummer kein Aufruf', async () => {
    expect(await ensureInvoiceNumberStartOnServer()).toBe('none');
    expect(calls).toEqual([]);
  });

  it('S2: einmal gesetzt, danach in dieser Sitzung kein zweiter Aufruf', async () => {
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 123 });
    antwort = () => ({ data: { applied: true, year: 2026, last_sequence: 123 }, error: null });
    expect(await ensureInvoiceNumberStartOnServer()).toBe('applied');
    expect(calls).toEqual([
      { name: 'set_workspace_invoice_number_start', p_workspace_id: 'ws-start', p_year: 2026, p_last_sequence: 123 },
    ]);
    expect(await ensureInvoiceNumberStartOnServer()).toBe('unchanged');
    expect(calls).toHaveLength(1);
  });

  it('S3: ein Server ohne die Funktion verhält sich wie bisher und wird später erneut gefragt', async () => {
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 7 });
    antwort = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    expect(await ensureInvoiceNumberStartOnServer()).toBe('unsupported');
    expect(await ensureInvoiceNumberStartOnServer()).toBe('unsupported');
    expect(calls).toHaveLength(2);
  });

  it('S4: ein benutzter Kreis bleibt; das ist kein Fehler und wird nicht wiederholt', async () => {
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 7 });
    antwort = () => ({ data: null, error: { code: 'P0001', message: 'invoice_number_start_locked: 3' } });
    expect(await ensureInvoiceNumberStartOnServer()).toBe('locked');
    expect(await ensureInvoiceNumberStartOnServer()).toBe('unchanged');
    expect(calls).toHaveLength(1);
  });

  it('S5: nur ein Netzfehler meldet „failed"; Rolle und Unbekanntes sperren nicht', async () => {
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 7 });
    antwort = () => ({ data: null, error: { message: 'Failed to fetch' } });
    expect(await ensureInvoiceNumberStartOnServer()).toBe('failed');
    antwort = () => ({ data: null, error: { code: '42501', message: 'Keine Schreibberechtigung' } });
    expect(await ensureInvoiceNumberStartOnServer()).toBe('forbidden');
    antwort = () => ({ data: null, error: { message: 'etwas Unerwartetes' } });
    expect(await ensureInvoiceNumberStartOnServer()).toBe('unsupported');
  });
});
