/**
 * FINANZ-CORE-DURABILITY-01D2 — Export-Gate und kanonisches Ausgaben-Stornodatum.
 *
 *  A  echter local-only Betrieb (keine Cloud konfiguriert)      -> erlaubt, kein RPC
 *  B  Cloud + owner/admin                                       -> erlaubt (RPC bestaetigt)
 *  C  Cloud + member                                            -> verboten, kein RPC noetig
 *  D  Cloud + member, Server nicht erreichbar                   -> verboten (kein Offline-Fallback)
 *  D' Cloud + lokal "owner", Server antwortet mit Fehler/Netz   -> verboten (Server ist die Grenze)
 *  E  Cloud + Mitgliedschaft lokal unbekannt                    -> verboten
 *  F  updateExpense: Uebergang nach storniert setzt cancelledAt genau einmal; Ruecknahme loescht
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../workspace/workspaceStore';
import { assertMonatsmappeAllowed } from './monatsmappeExportService';
import { hydrateExpenseStore, getExpenseFromStoreById } from '../expenseStore';
import { updateExpense } from '../expenseService';
import type { Expense } from '../../types/expense';

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = 'user-owner';
const MEMBER = 'user-member';

function seedWorkspace(): void {
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'WS', ownerUserId: OWNER, createdAt: 'x', updatedAt: 'x', version: 1 } as never,
    workspaceMembers: [
      { workspaceId: WS, userId: OWNER, role: 'owner', status: 'active', createdAt: 'x', updatedAt: 'x' },
      { workspaceId: WS, userId: MEMBER, role: 'member', status: 'active', createdAt: 'x', updatedAt: 'x' },
    ] as never,
  } as never);
}

describe('01D2 — Export-Gate', () => {
  beforeEach(() => {
    resetWorkspaceStore();
    seedWorkspace();
  });
  afterEach(() => vi.restoreAllMocks());

  it('A: local-only Betrieb -> erlaubt, ohne Server', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const rpc = vi.fn();
    const result = await assertMonatsmappeAllowed({ userId: undefined, client: { rpc } as never });
    expect(result).toEqual({ allowed: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('B: Cloud + owner -> erlaubt, serverseitig bestaetigt', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const rpc = vi.fn(async () => ({ data: { allowed: true }, error: null }));
    const result = await assertMonatsmappeAllowed({ userId: OWNER, client: { rpc } as never });
    expect(result).toEqual({ allowed: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('assert_workspace_finance_export');
  });

  it('C: Cloud + member -> verboten', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const rpc = vi.fn(async () => ({ data: { allowed: true }, error: null }));
    const result = await assertMonatsmappeAllowed({ userId: MEMBER, client: { rpc } as never });
    expect(result).toEqual({ allowed: false, detail: 'member' });
  });

  it('D: Cloud + member + Server nicht erreichbar -> bleibt verboten (kein Offline-Fallback)', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const rpc = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const result = await assertMonatsmappeAllowed({ userId: MEMBER, client: { rpc } as never });
    expect(result.allowed).toBe(false);
    // Netzwerkfehler wird nie als "kein Cloudbetrieb" gelesen: kein Client -> ebenfalls verboten.
    const withoutClient = await assertMonatsmappeAllowed({ userId: MEMBER, client: null });
    expect(withoutClient.allowed).toBe(false);
  });

  it("D': Cloud + lokal owner, Server lehnt ab oder ist nicht erreichbar -> verboten", async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const denied = await assertMonatsmappeAllowed({ userId: OWNER, client: { rpc: async () => ({ data: null, error: { message: 'Kein Zugriff auf Workspace' } }) } as never });
    expect(denied).toEqual({ allowed: false, detail: 'Kein Zugriff auf Workspace' });
    const network = await assertMonatsmappeAllowed({ userId: OWNER, client: { rpc: async () => { throw new TypeError('Failed to fetch'); } } as never });
    expect(network.allowed).toBe(false);
    expect(network.allowed ? '' : network.detail).toContain('Failed to fetch');
  });

  it('E: Cloud + Mitgliedschaft unbekannt -> verboten', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const result = await assertMonatsmappeAllowed({ userId: 'user-unknown', client: { rpc: async () => ({ data: { allowed: true }, error: null }) } as never });
    expect(result).toEqual({ allowed: false, detail: 'membership_unknown' });
  });
});

describe('01D2 — kanonisches Ausgaben-Stornodatum', () => {
  const base: Expense = {
    id: 'exp-real-x', status: 'gebucht', category: 'material', supplierName: 'Lieferant GmbH', invoiceNumber: 'L-1', title: 'T', description: '',
    issueDate: '2026-08-05', paymentDueDate: null, taxStatus: 'standard_19', netAmount: 100, taxAmount: 19, grossAmount: 119, currency: 'EUR',
    paymentStatus: 'offen', payments: [], positions: [], allocations: [], isCreditNote: false, dedupeKey: 'lieferant gmbh|l-1', tags: [],
    digitalFolder: { id: 'd', name: 'A', path: '/A/' }, paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-08-05T10:00:00.000Z', updatedAt: '2026-08-05T10:00:00.000Z',
  };

  it('F: Uebergang nach storniert setzt cancelledAt einmal, Folge-Update behaelt es, Ruecknahme loescht es', () => {
    hydrateExpenseStore([base]);
    expect(getExpenseFromStoreById('exp-real-x')?.cancelledAt).toBeUndefined();
    expect(updateExpense('exp-real-x', { status: 'storniert' }).success).toBe(true);
    const first = getExpenseFromStoreById('exp-real-x')!;
    expect(first.status).toBe('storniert');
    expect(first.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updateExpense('exp-real-x', { title: 'Neu' }).success).toBe(true);
    expect(getExpenseFromStoreById('exp-real-x')?.cancelledAt).toBe(first.cancelledAt);
    expect(updateExpense('exp-real-x', { status: 'gebucht' }).success).toBe(true);
    expect(getExpenseFromStoreById('exp-real-x')?.cancelledAt).toBeUndefined();
    expect(getExpenseFromStoreById('exp-real-x')?.status).toBe('gebucht');
  });
});
