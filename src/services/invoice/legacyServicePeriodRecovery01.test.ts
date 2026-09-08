/**
 * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — nachträgliche Bestätigung.
 *
 * Rechnungen aus der Zeit vor `servicePeriodConfirmed` tragen den Wert nicht.
 * Der PDF-Pfad blockiert sie zu Recht — es fehlte nur der Weg, den bereits
 * gespeicherten Leistungszeitraum ausdrücklich nachzubestätigen.
 *
 * Geprüft wird: die lokale monotone Mutation, ihre Vorbedingungen, die
 * Unversehrtheit des übrigen Rechnungsinhalts, und der schmale Cloud-Weg —
 * eine Confirm-Mutation ohne Boolean und ein Einzelread, der niemals den
 * ganzen Workspace zieht. Kein Netzwerk: der Supabase-Client wird ersetzt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vorgang, VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore, getVorgangInvoice, immutableInvoiceFingerprint } from '../vorgangService';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import { validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import {
  canConfirmInvoiceServicePeriod,
  confirmFinalizedInvoiceServicePeriod,
  needsServicePeriodRecovery,
  readInvoiceServicePeriodConfirmationFromCloud,
  syncInvoiceServicePeriodConfirmationToCloud,
} from './invoiceServicePeriodConfirmService';
import {
  WorkspaceInvoiceCloudError,
  buildWorkspaceInvoiceFinalizePayload,
  rpcConfirmWorkspaceInvoiceServicePeriod,
  rpcGetWorkspaceInvoiceServicePeriodConfirmation,
} from './workspaceInvoiceCloudService';

const WORKSPACE = '00000000-0000-4000-8000-000000000042';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-legacy-sp-1';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  iban: 'DE00 0000 0000 0000 0000 00',
};

/** Eine finalisierte Rechnung von vor dem Feld: Zeitraum ja, Bestätigung nein. */
function legacyInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0011',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Beispielleistung',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
    ],
    subtotal: 520,
    taxStatus: 'standard_19',
    amount: 618.8,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    introText: 'Einleitung',
    closingText: 'Schluss',
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

function seed(invoice: VorgangInvoice): Vorgang {
  hydrateCompanyProfileStore(companySnapshot);
  const vorgang = createTestVorgang({ id: VORGANG_ID, invoices: [invoice] });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

function codes(invoice: VorgangInvoice): string[] {
  return validateFinalizedInvoiceForPdf(invoice).blockingErrors.map((e) => e.code);
}

describe('SP-RECOVERY-01B — Ausgangslage', () => {
  beforeEach(() => seed(legacyInvoice()));

  it('R1: eine Legacy-Rechnung ohne Bestätigung bleibt für PDF blockiert', async () => {
    const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    expect(invoice.servicePeriodConfirmed).toBeUndefined();
    expect(codes(invoice)).toContain('service_period_unconfirmed');
    expect((await generateApprovedInvoicePdf(invoice)).ok).toBe(false);
  });

  it('R3: ein gültiger gespeicherter Zeitraum macht das Recovery anwendbar', () => {
    const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    expect(canConfirmInvoiceServicePeriod(invoice)).toBe(true);
    expect(needsServicePeriodRecovery(invoice)).toBe(true);
  });

  it('R18: eine bereits bestätigte Rechnung braucht kein Recovery', () => {
    const invoice = legacyInvoice({ servicePeriodConfirmed: true });
    expect(needsServicePeriodRecovery(invoice)).toBe(false);
  });
});

describe('SP-RECOVERY-01B — lokale Bestätigung', () => {
  beforeEach(() => seed(legacyInvoice()));

  it('R4: die Nutzeraktion setzt genau servicePeriodConfirmed = true', () => {
    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('confirmed');
    expect(result.invoice.servicePeriodConfirmed).toBe(true);
  });

  it('R5: kein anderer Rechnungsinhalt wird verändert', () => {
    const before = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * Feldweise statt stichprobenartig: Alles ausser der Bestätigung selbst
     * muss byte-gleich sein — Zeitraum, Beträge, Snapshots, Storno, Versand.
     */
    const { servicePeriodConfirmed: _after, ...restAfter } = result.invoice;
    const { servicePeriodConfirmed: _before, ...restBefore } = before;
    expect(JSON.stringify(restAfter)).toBe(JSON.stringify(restBefore));
  });

  it('R6: die Bestätigung überlebt die Neuprojektion aus dem Speicher', () => {
    confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.servicePeriodConfirmed).toBe(true);
  });

  it('R7: danach ist die PDF-Erzeugung möglich', async () => {
    confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    expect(codes(invoice)).not.toContain('service_period_unconfirmed');
    expect((await generateApprovedInvoicePdf(invoice)).ok).toBe(true);
  });

  it('R9: eine zweite Bestätigung ist ein Noop und schreibt nicht erneut', () => {
    confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    const again = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.action).toBe('noop');
    expect(again.invoice.servicePeriodConfirmed).toBe(true);
  });

  it('R15/R16: archiveDocumentId und beide Fingerprints bleiben identisch', () => {
    seed(legacyInvoice({ archiveDocumentId: 'doc-legacy-1' }));
    const before = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    const fingerprintBefore = immutableInvoiceFingerprint(before, VORGANG_ID);
    const contentBefore = buildInvoiceContentFingerprintFromInvoice(before);

    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.invoice.archiveDocumentId).toBe('doc-legacy-1');
    expect(immutableInvoiceFingerprint(result.invoice, VORGANG_ID)).toBe(fingerprintBefore);
    expect(buildInvoiceContentFingerprintFromInvoice(result.invoice)).toBe(contentBefore);
  });
});

describe('SP-RECOVERY-01B — Vorbedingungen sind fail-closed', () => {
  it('R10: ohne gespeicherten Zeitraum kein Recovery', () => {
    for (const missing of [
      { servicePeriodFrom: undefined },
      { servicePeriodTo: undefined },
      { servicePeriodFrom: undefined, servicePeriodTo: undefined },
    ]) {
      const invoice = legacyInvoice(missing);
      expect(canConfirmInvoiceServicePeriod(invoice)).toBe(false);
      seed(invoice);
      const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('service_period_missing');
    }
  });

  it('R11: ein ungültiges Datum wird nicht bestätigt', () => {
    for (const broken of ['01.09.2026', '2026-13-01', '2026-02-30', '2026-9-1', '']) {
      const invoice = legacyInvoice({ servicePeriodFrom: broken });
      expect(canConfirmInvoiceServicePeriod(invoice), broken).toBe(false);
    }
    seed(legacyInvoice({ servicePeriodFrom: '2026-02-30' }));
    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('service_period_invalid');
  });

  it('R12: ein verdrehter Zeitraum wird nicht bestätigt', () => {
    const invoice = legacyInvoice({ servicePeriodFrom: '2026-09-05', servicePeriodTo: '2026-09-01' });
    expect(canConfirmInvoiceServicePeriod(invoice)).toBe(false);
    seed(invoice);
    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('service_period_invalid');
  });

  it('R13: ein nicht finalisierter Entwurf wird abgewiesen', () => {
    const invoice = legacyInvoice({ status: 'entwurf' });
    expect(canConfirmInvoiceServicePeriod(invoice)).toBe(false);
    seed(invoice);
    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_finalized');
  });

  it('R13b: eine unbekannte Rechnung oder ein fremder Vorgang wird abgewiesen', () => {
    seed(legacyInvoice());
    for (const [vorgangId, invoiceId] of [
      [VORGANG_ID, 'inv-does-not-exist'],
      ['v-does-not-exist', INVOICE_ID],
    ]) {
      const result = confirmFinalizedInvoiceServicePeriod(vorgangId!, invoiceId!);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('invoice_missing');
    }
  });

  it('R14: eine stornierte finalisierte Rechnung bleibt bestätigbar, ohne den Storno zu berühren', () => {
    seed(
      legacyInvoice({
        status: 'versendet',
        cancelledAt: '2026-07-01T09:00:00.000Z',
        cancelReason: 'Doppelt gestellt',
        paymentStatus: 'storniert',
      }),
    );
    const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.servicePeriodConfirmed).toBe(true);
    expect(result.invoice.cancelledAt).toBe('2026-07-01T09:00:00.000Z');
    expect(result.invoice.cancelReason).toBe('Doppelt gestellt');
    expect(result.invoice.paymentStatus).toBe('storniert');
    expect(result.invoice.status).toBe('versendet');
  });

  it('R17: alle finalisierbaren Rechnungstypen verhalten sich gleich', () => {
    for (const type of ['rechnung', 'abschlag', 'teilrechnung', 'schluss'] as const) {
      seed(legacyInvoice({ type, abschlagNumber: type === 'abschlag' ? 1 : undefined }));
      const result = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
      expect(result.ok, type).toBe(true);
      if (!result.ok) continue;
      expect(result.invoice.servicePeriodConfirmed, type).toBe(true);
      expect(result.invoice.type, type).toBe(type);
    }

    seed(legacyInvoice({ type: 'abschlag', calculationMode: 'fixed_amount', fixedAmountNet: 500, positions: [] }));
    const fixed = confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID);
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.invoice.servicePeriodConfirmed).toBe(true);
    expect(fixed.invoice.calculationMode).toBe('fixed_amount');
  });
});

describe('SP-RECOVERY-01B — Confirm-RPC', () => {
  const confirmedRow = () => ({
    id: 'row-1',
    workspace_id: WORKSPACE,
    vorgang_id: VORGANG_ID,
    client_invoice_id: INVOICE_ID,
    invoice_number: '2026-0011',
    invoice_year: 2026,
    invoice_sequence_number: 11,
    invoice_type: 'rechnung',
    invoice_status: 'vorbereitet',
    row_version: 2,
    payload: buildWorkspaceInvoiceFinalizePayload(legacyInvoice({ servicePeriodConfirmed: true })),
  });

  it('R22: der Client sendet nur Workspace und Rechnung — kein Boolean', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: [confirmedRow()], error: null };
      }),
    } as never;

    await rpcConfirmWorkspaceInvoiceServicePeriod(
      { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
      { client },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('confirm_workspace_invoice_service_period');
    expect(Object.keys(calls[0].args).sort()).toEqual(['p_client_invoice_id', 'p_workspace_id']);
    expect(Object.values(calls[0].args)).not.toContain(false);
  });

  it('R23: Erfolg gilt nur, wenn die Rückgabe true beweist', async () => {
    const unconfirmed = {
      ...confirmedRow(),
      payload: buildWorkspaceInvoiceFinalizePayload(legacyInvoice()),
    };
    const client = {
      rpc: vi.fn(async () => ({ data: [unconfirmed], error: null })),
    } as never;

    await expect(
      rpcConfirmWorkspaceInvoiceServicePeriod(
        { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
        { client },
      ),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });

  it('R23b: eine bestätigende Rückgabe wird angenommen', async () => {
    const client = { rpc: vi.fn(async () => ({ data: [confirmedRow()], error: null })) } as never;
    const mapped = await rpcConfirmWorkspaceInvoiceServicePeriod(
      { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
      { client },
    );
    expect(mapped.invoice.servicePeriodConfirmed).toBe(true);
    expect(mapped.clientInvoiceId).toBe(INVOICE_ID);
  });

  it('R23c: eine fremde Zeile oder ein Serverfehler ist kein Erfolg', async () => {
    const foreign = { ...confirmedRow(), workspace_id: '00000000-0000-4000-8000-000000000099' };
    for (const response of [
      { data: [foreign], error: null },
      { data: [], error: null },
      { data: null, error: { message: 'Kein Zugriff auf Workspace' } },
    ]) {
      const client = { rpc: vi.fn(async () => response) } as never;
      await expect(
        rpcConfirmWorkspaceInvoiceServicePeriod(
          { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
          { client },
        ),
      ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }
  });
});

describe('SP-RECOVERY-01B — schmaler Einzelread', () => {
  it('R36/R38: der Read fragt genau eine Rechnung und zieht keine Liste', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: { found: true, service_period_confirmed: true }, error: null };
      }),
    } as never;

    const state = await rpcGetWorkspaceInvoiceServicePeriodConfirmation(
      { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
      { client },
    );

    expect(state).toEqual({ found: true, confirmed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('get_workspace_invoice_service_period_confirmation');
    expect(calls[0].args.p_client_invoice_id).toBe(INVOICE_ID);
    // Kein Workspace-Pull für die Prüfung eines einzigen Booleans.
    expect(calls.some((c) => c.name === 'pull_workspace_invoices')).toBe(false);
  });

  it('R25/R26: fehlend, null und false zählen alle als nicht gesichert', async () => {
    for (const raw of [
      { found: true, service_period_confirmed: false },
      { found: true, service_period_confirmed: null },
      { found: true },
    ]) {
      const client = { rpc: vi.fn(async () => ({ data: raw, error: null })) } as never;
      const state = await rpcGetWorkspaceInvoiceServicePeriodConfirmation(
        { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
        { client },
      );
      expect(state.confirmed).toBe(false);
    }
  });

  it('R37: eine unbekannte Rechnung meldet found=false statt eines erfundenen true', async () => {
    const client = {
      rpc: vi.fn(async () => ({ data: { found: false, service_period_confirmed: null }, error: null })),
    } as never;
    const state = await rpcGetWorkspaceInvoiceServicePeriodConfirmation(
      { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
      { client },
    );
    expect(state).toEqual({ found: false, confirmed: false });
  });

  it('R37b: ein Membership-Fehler wird zum Cloud-Fehler, nicht zu "nicht bestätigt"', async () => {
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'Kein Zugriff auf Workspace' } })),
    } as never;
    await expect(
      rpcGetWorkspaceInvoiceServicePeriodConfirmation(
        { workspaceId: WORKSPACE, clientInvoiceId: INVOICE_ID },
        { client },
      ),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });
});

describe('SP-RECOVERY-01B — Reconciliation-Zustände', () => {
  beforeEach(() => seed(legacyInvoice({ servicePeriodConfirmed: true })));

  it('R30: ohne eingerichtete Cloud wird nicht gelesen und nichts behauptet', async () => {
    const supabase = await import('../../lib/supabase');
    const spy = vi.spyOn(supabase, 'isSupabaseConfigured').mockReturnValue(false);
    try {
      expect(await readInvoiceServicePeriodConfirmationFromCloud(INVOICE_ID)).toBe('not_configured');
    } finally {
      spy.mockRestore();
    }
  });

  it('R27: bei konfigurierter, aber nicht erreichbarer Cloud gilt "unbekannt"', async () => {
    /*
     * Der gemockte Client beantwortet diese RPC nicht — genau der Fall, den es
     * abzudecken gilt. Wichtig ist, was NICHT passiert: keine Aussage
     * „gesichert" und keine Aussage „nicht gesichert".
     */
    const state = await readInvoiceServicePeriodConfirmationFromCloud(INVOICE_ID);
    expect(state).toBe('unknown');
    expect(state).not.toBe('confirmed');
    expect(state).not.toBe('not_confirmed');
  });

  /*
   * 01B2 — der Cloud-Zustand steuert, ob ein Sicherungsknopf überhaupt
   * erscheinen darf. Nur `not_confirmed` ist reparierbar.
   */
  async function cloudState(raw: unknown): Promise<string> {
    const cloud = await import('./workspaceInvoiceCloudService');
    const spy = vi
      .spyOn(cloud, 'rpcGetWorkspaceInvoiceServicePeriodConfirmation')
      .mockImplementation(async () => {
        if (raw instanceof Error) throw raw;
        return raw as { found: boolean; confirmed: boolean };
      });
    try {
      return await readInvoiceServicePeriodConfirmationFromCloud(INVOICE_ID);
    } finally {
      spy.mockRestore();
    }
  }

  it('E1: found + confirmed ergibt synced', async () => {
    expect(await cloudState({ found: true, confirmed: true })).toBe('confirmed');
  });

  it('E2: vorhandene Cloud-Rechnung ohne Bestätigung ist reparierbar', async () => {
    expect(await cloudState({ found: true, confirmed: false })).toBe('not_confirmed');
  });

  it('E3: eine in der Cloud fehlende Rechnung ist nicht "noch nicht gesichert"', async () => {
    /*
     * Der Kern der Korrektur: `confirm_workspace_invoice_service_period` kann
     * nur eine vorhandene Zeile ergänzen. Ohne Zeile wäre „Jetzt sichern" ein
     * Knopf, der strukturell nie gelingen kann.
     */
    const state = await cloudState({ found: false, confirmed: false });
    expect(state).toBe('missing');
    expect(state).not.toBe('not_confirmed');
  });

  it('E4: ein Read-Fehler bleibt unbekannt', async () => {
    const state = await cloudState(new Error('network'));
    expect(state).toBe('unknown');
    expect(state).not.toBe('not_confirmed');
    expect(state).not.toBe('confirmed');
  });

  it('E5: in keinem dieser Fälle ändert sich die lokale Bestätigung', async () => {
    for (const raw of [
      { found: true, confirmed: true },
      { found: true, confirmed: false },
      { found: false, confirmed: false },
      new Error('network'),
    ]) {
      await cloudState(raw);
      expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.servicePeriodConfirmed).toBe(true);
    }
  });

  it('E6: der Retry nutzt weiterhin dieselbe Confirm-RPC', async () => {
    const cloud = await import('./workspaceInvoiceCloudService');
    const spy = vi
      .spyOn(cloud, 'rpcConfirmWorkspaceInvoiceServicePeriod')
      .mockResolvedValue({} as never);
    try {
      const outcome = await syncInvoiceServicePeriodConfirmationToCloud(VORGANG_ID, INVOICE_ID);
      expect(outcome).toBe('synced');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toEqual({
        workspaceId: expect.any(String),
        clientInvoiceId: INVOICE_ID,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('E6b: eine in der Cloud fehlende Rechnung meldet einen Fehlschlag, keinen Erfolg', async () => {
    const cloud = await import('./workspaceInvoiceCloudService');
    const spy = vi
      .spyOn(cloud, 'rpcConfirmWorkspaceInvoiceServicePeriod')
      .mockRejectedValue(new Error('Rechnung nicht gefunden'));
    try {
      expect(await syncInvoiceServicePeriodConfirmationToCloud(VORGANG_ID, INVOICE_ID)).toBe(
        'failed',
      );
      // Die lokale Entscheidung bleibt trotzdem stehen.
      expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.servicePeriodConfirmed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('R31: eine lokal unbestätigte Rechnung braucht Recovery statt Sicherung', () => {
    seed(legacyInvoice());
    const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
    expect(needsServicePeriodRecovery(invoice)).toBe(true);
  });

  it('R32/R33/R34: der Read verändert die lokale Rechnung nicht', async () => {
    const before = JSON.stringify(getVorgangInvoice(VORGANG_ID, INVOICE_ID));
    await readInvoiceServicePeriodConfirmationFromCloud(INVOICE_ID);
    expect(JSON.stringify(getVorgangInvoice(VORGANG_ID, INVOICE_ID))).toBe(before);
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.servicePeriodConfirmed).toBe(true);
  });
});
