/**
 * GO-LIVE-SECURITY-01 — Client-Nacharbeit: Versandvermerk und Leistungszeitraum.
 *
 * Beide Aktionen sind verbindlich und nur Inhaber und Verwaltung erlaubt; der
 * Server weist Mitglieder ab. Geprüft wird hier der Client:
 *
 *  - die Dienste prüfen die Rolle vor jeder lokalen Änderung (auch ohne Angabe),
 *  - eine Rollenabweisung des Servers hinterlässt keinen lokalen Scheinerfolg,
 *  - ein nicht freigegebener Altzustand auf dem Gerät eines Mitglieds gibt
 *    weder PDF und Druck noch eine Mahnung frei,
 *  - Inhaber, Verwaltung und der lokale Betrieb ohne Cloud behalten alles.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import type { VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { canDocumentDunningForInvoice } from '../dunningDocumentationService';
import {
  alignInvoiceSentWithCloudForMember,
  captureInvoiceSentState,
  markInvoiceAsSent,
  revertInvoiceSentAfterRoleDenial,
  syncInvoiceSentToCloud,
  updateInvoiceSentDetails,
} from '../invoiceSentService';
import {
  alignServicePeriodConfirmationForMember,
  confirmFinalizedInvoiceServicePeriod,
  revertServicePeriodConfirmationAfterRoleDenial,
  syncInvoiceServicePeriodConfirmationToCloud,
} from './invoiceServicePeriodConfirmService';
import { alignInvoiceFactsForMember } from './invoiceMemberAlignment';
import { applyInvoicePullAfterVorgangMerge } from './invoiceCloudPullOrchestrator';
import * as invoiceCloud from './workspaceInvoiceCloudService';
import { WorkspaceInvoiceCloudError } from './workspaceInvoiceCloudService';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import * as supabaseLib from '../../lib/supabase';
import * as workspacePayload from '../workspace/workspaceSyncPayloadService';

const WORKSPACE = '00000000-0000-4000-8000-000000000a01';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-gls01-rolle';
const MITGLIED = { userId: 'user-mitglied', cloudConfigured: true };
const INHABER = { userId: 'user-inhaber', cloudConfigured: true };
const EINGABE = { sentAt: '2026-09-10', sentVia: 'post' as const };

/** Finalisierte Rechnung mit offenem Betrag; ohne Bestätigung des Leistungszeitraums (Altbestand). */
function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0031',
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
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-05',
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
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH', iban: 'DE00 0000 0000 0000 0000 00' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

const versendet = (overrides: Partial<VorgangInvoice> = {}) =>
  rechnung({ status: 'versendet', sentAt: '2026-06-02', sentVia: 'email', sentSource: 'manual', ...overrides });

function seed(invoice: VorgangInvoice): void {
  hydrateCompanyProfileStore(invoice.companySnapshot!);
  hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [invoice] })]);
}

function lokal(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

function pdfSperren(invoice: VorgangInvoice): string[] {
  return validateFinalizedInvoiceForPdf(invoice).blockingErrors.map((error) => error.code);
}

function cloudBereit(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
}

const rollenAbweisung = () => new WorkspaceInvoiceCloudError('Keine Schreibberechtigung', 'rls', false);

beforeEach(() => resetTestStores());
afterEach(() => vi.restoreAllMocks());

describe('GLS01 Versandvermerk — Mitglied', () => {
  it('V1: ein Mitglied vermerkt keinen Versand; lokal bleibt alles, wie es war', () => {
    alsMitglied();
    seed(rechnung());
    const vorher = lokal();
    const rpc = vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent');

    expect(markInvoiceAsSent(VORGANG_ID, INVOICE_ID, EINGABE, MITGLIED)).toEqual({ ok: false, reason: 'forbidden' });

    expect(lokal()).toEqual(vorher);
    expect(lokal().status).toBe('vorbereitet');
    expect(canDocumentDunningForInvoice(lokal())).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('V2: auch einen bestehenden Versand korrigiert ein Mitglied nicht', () => {
    alsMitglied();
    seed(versendet());
    const vorher = lokal();

    expect(updateInvoiceSentDetails(VORGANG_ID, INVOICE_ID, EINGABE, MITGLIED)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(lokal()).toEqual(vorher);
  });

  it('V3: „Jetzt sichern" ruft für ein Mitglied den Server gar nicht erst', async () => {
    alsMitglied();
    seed(versendet());
    cloudBereit();
    const rpc = vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent');

    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID, MITGLIED)).resolves.toBe('forbidden');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('V4: ohne Rollenangabe gilt die strengste Annahme — nichts wird geändert', () => {
    seed(rechnung());
    const vorher = lokal();

    expect(markInvoiceAsSent(VORGANG_ID, INVOICE_ID, EINGABE)).toEqual({ ok: false, reason: 'forbidden' });
    expect(lokal()).toEqual(vorher);
  });

  it('V5: der bewusst lokale Betrieb ohne Cloud bleibt erlaubt', () => {
    seed(rechnung());
    const result = markInvoiceAsSent(VORGANG_ID, INVOICE_ID, EINGABE, { userId: null, cloudConfigured: false });
    expect(result.ok).toBe(true);
    expect(lokal().status).toBe('versendet');
  });
});

describe('GLS01 Versandvermerk — Rollenabweisung des Servers', () => {
  it('V6: Gerät hält sich für Inhaber, Server weist ab: der Stand davor gilt wieder', async () => {
    alsInhaber();
    seed(rechnung());
    cloudBereit();
    vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent').mockRejectedValue(rollenAbweisung());

    const vorher = captureInvoiceSentState(VORGANG_ID, INVOICE_ID)!;
    expect(markInvoiceAsSent(VORGANG_ID, INVOICE_ID, EINGABE, INHABER).ok).toBe(true);
    expect(lokal().status).toBe('versendet');

    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID, INHABER)).resolves.toBe('forbidden');
    expect(revertInvoiceSentAfterRoleDenial(VORGANG_ID, INVOICE_ID, vorher).ok).toBe(true);

    const danach = lokal();
    expect(danach.status).toBe('vorbereitet');
    expect(danach.sentAt).toBeUndefined();
    expect(danach.sentVia).toBeUndefined();
    expect(danach.sentSource).toBeUndefined();
    expect(canDocumentDunningForInvoice(danach)).toBe(false);
    // Nur die Versandfelder: Rechnungsinhalt unverändert.
    expect(danach.amount).toBe(618.8);
    expect(danach.positions).toEqual(rechnung().positions);
  });

  it('V7: ein Netzfehler bleibt ein Netzfehler — der Vermerk des Inhabers bleibt stehen', async () => {
    alsInhaber();
    seed(rechnung());
    cloudBereit();
    vi.spyOn(invoiceCloud, 'rpcUpdateWorkspaceInvoiceSent').mockRejectedValue(
      new WorkspaceInvoiceCloudError('Failed to fetch', 'network', true),
    );

    markInvoiceAsSent(VORGANG_ID, INVOICE_ID, EINGABE, INHABER);
    await expect(syncInvoiceSentToCloud(VORGANG_ID, INVOICE_ID, INHABER)).resolves.toBe('failed');
    expect(lokal().status).toBe('versendet');
  });
});

describe('GLS01 Versandvermerk — Altzustand auf dem Gerät eines Mitglieds', () => {
  it('V8: ein Vermerk, den die Cloud nicht trägt, wird zurückgenommen; die Mahnung entfällt', async () => {
    alsMitglied();
    seed(versendet());
    cloudBereit();
    expect(canDocumentDunningForInvoice(lokal())).toBe(true);
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockResolvedValue({
      found: true,
      snapshot: null,
      status: 'vorbereitet',
    });

    const angeglichen = await alignInvoiceSentWithCloudForMember(VORGANG_ID, INVOICE_ID, MITGLIED);

    expect(angeglichen?.status).toBe('vorbereitet');
    expect(lokal().status).toBe('vorbereitet');
    expect(lokal().sentAt).toBeUndefined();
    expect(canDocumentDunningForInvoice(lokal())).toBe(false);
  });

  it('V9: abweichende Versanddaten übernehmen den Cloud-Stand', async () => {
    alsMitglied();
    seed(versendet({ sentAt: '2026-06-09', sentVia: 'post' }));
    cloudBereit();
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockResolvedValue({
      found: true,
      snapshot: { sentAt: '2026-06-02', sentVia: 'email' },
      status: 'versendet',
    });

    await alignInvoiceSentWithCloudForMember(VORGANG_ID, INVOICE_ID, MITGLIED);

    expect(lokal()).toMatchObject({ status: 'versendet', sentAt: '2026-06-02', sentVia: 'email' });
  });

  it('V10: Inhaber behalten ihren noch nicht gesicherten Vermerk', async () => {
    alsInhaber();
    seed(versendet());
    cloudBereit();
    const read = vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent');

    await expect(alignInvoiceSentWithCloudForMember(VORGANG_ID, INVOICE_ID, INHABER)).resolves.toBeNull();
    expect(lokal().status).toBe('versendet');
    expect(read).not.toHaveBeenCalled();
  });

  it('V11: ohne Cloud-Antwort ändert sich nichts', async () => {
    alsMitglied();
    seed(versendet());
    cloudBereit();
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockRejectedValue(new Error('offline'));

    await expect(alignInvoiceSentWithCloudForMember(VORGANG_ID, INVOICE_ID, MITGLIED)).resolves.toBeNull();
    expect(lokal().status).toBe('versendet');
  });
});

describe('GLS01 Leistungszeitraum', () => {
  it('L1: ein Mitglied bestätigt nicht; PDF und Druck bleiben gesperrt', () => {
    alsMitglied();
    seed(rechnung());

    expect(confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID, MITGLIED)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(lokal().servicePeriodConfirmed).toBeUndefined();
    expect(pdfSperren(lokal())).toContain('service_period_unconfirmed');
  });

  it('L2: „Jetzt sichern" ruft für ein Mitglied den Server gar nicht erst', async () => {
    alsMitglied();
    seed(rechnung({ servicePeriodConfirmed: true }));
    cloudBereit();
    const rpc = vi.spyOn(invoiceCloud, 'rpcConfirmWorkspaceInvoiceServicePeriod');

    await expect(syncInvoiceServicePeriodConfirmationToCloud(VORGANG_ID, INVOICE_ID, MITGLIED)).resolves.toBe(
      'forbidden',
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('L3: Rollenabweisung des Servers nimmt die Bestätigung zurück; PDF wieder gesperrt', async () => {
    alsInhaber();
    seed(rechnung());
    cloudBereit();
    vi.spyOn(invoiceCloud, 'rpcConfirmWorkspaceInvoiceServicePeriod').mockRejectedValue(rollenAbweisung());

    expect(confirmFinalizedInvoiceServicePeriod(VORGANG_ID, INVOICE_ID, INHABER).ok).toBe(true);
    expect(pdfSperren(lokal())).not.toContain('service_period_unconfirmed');

    await expect(syncInvoiceServicePeriodConfirmationToCloud(VORGANG_ID, INVOICE_ID, INHABER)).resolves.toBe(
      'forbidden',
    );
    expect(revertServicePeriodConfirmationAfterRoleDenial(VORGANG_ID, INVOICE_ID, undefined).ok).toBe(true);

    expect(lokal().servicePeriodConfirmed).toBeUndefined();
    expect(pdfSperren(lokal())).toContain('service_period_unconfirmed');
  });

  it('L4: auch eine vorher schon lokale Bestätigung wird nach der Abweisung nie wieder true', () => {
    alsInhaber();
    seed(rechnung({ servicePeriodConfirmed: true }));
    revertServicePeriodConfirmationAfterRoleDenial(VORGANG_ID, INVOICE_ID, true);
    expect(lokal().servicePeriodConfirmed).toBe(false);
    expect(pdfSperren(lokal())).toContain('service_period_unconfirmed');
  });

  it('L5: Altzustand auf Mitgliedsgerät — nachweislich unbestätigt wird zurückgenommen', () => {
    alsMitglied();
    seed(rechnung({ servicePeriodConfirmed: true }));

    expect(alignServicePeriodConfirmationForMember(VORGANG_ID, INVOICE_ID, 'unknown', MITGLIED)).toBeNull();
    expect(alignServicePeriodConfirmationForMember(VORGANG_ID, INVOICE_ID, 'confirmed', MITGLIED)).toBeNull();
    expect(lokal().servicePeriodConfirmed).toBe(true);

    const angeglichen = alignServicePeriodConfirmationForMember(VORGANG_ID, INVOICE_ID, 'not_confirmed', MITGLIED);
    expect(angeglichen?.servicePeriodConfirmed).toBe(false);
    expect(pdfSperren(lokal())).toContain('service_period_unconfirmed');
  });

  it('L6: Inhaber behalten ihre lokale Bestätigung', () => {
    alsInhaber();
    seed(rechnung({ servicePeriodConfirmed: true }));
    expect(alignServicePeriodConfirmationForMember(VORGANG_ID, INVOICE_ID, 'not_confirmed', INHABER)).toBeNull();
    expect(lokal().servicePeriodConfirmed).toBe(true);
  });
});

describe('GLS01 Pull — Gerät eines Mitglieds', () => {
  it('P1: die reine Regel', () => {
    const cloudUnversendet = rechnung();
    expect(alignInvoiceFactsForMember(versendet(), cloudUnversendet)).toMatchObject({ status: 'vorbereitet' });
    expect(alignInvoiceFactsForMember(versendet(), cloudUnversendet)?.sentAt).toBeUndefined();
    // Gleicher Stand: nichts zu tun.
    expect(alignInvoiceFactsForMember(versendet(), versendet())).toBeNull();
    // Ein Versand über OfficeTakt setzt nur der Server — er bleibt.
    expect(alignInvoiceFactsForMember(versendet({ sentSource: 'officepilot' }), cloudUnversendet)).toBeNull();
    // Bestätigung ohne Cloud-Gegenstück fällt auf false.
    expect(
      alignInvoiceFactsForMember(rechnung({ servicePeriodConfirmed: true }), rechnung())?.servicePeriodConfirmed,
    ).toBe(false);
    expect(
      alignInvoiceFactsForMember(rechnung({ servicePeriodConfirmed: true }), rechnung({ servicePeriodConfirmed: true })),
    ).toBeNull();
  });

  async function ziehe(alignForMember: boolean): Promise<VorgangInvoice> {
    const cloudInvoice = createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-gls01-pull',
      number: '2026-0001',
      invoiceSequenceNumber: 1,
      status: 'vorbereitet',
    });
    delete cloudInvoice.servicePeriodConfirmed;
    const row = {
      id: 'cloud-row-gls01',
      workspace_id: 'ws-1',
      vorgang_id: 'v-test-1',
      client_invoice_id: cloudInvoice.id,
      invoice_number: cloudInvoice.number,
      invoice_year: 2026,
      invoice_sequence_number: 1,
      invoice_type: cloudInvoice.type,
      invoice_status: 'vorbereitet',
      payload: { ...cloudInvoice },
      row_version: 1,
      created_at: '2026-07-23T10:00:00.000Z',
      updated_at: '2026-07-23T10:00:00.000Z',
    };
    const lokalerStand: VorgangInvoice = {
      ...cloudInvoice,
      status: 'versendet',
      sentAt: '2026-08-01',
      sentVia: 'post',
      sentSource: 'manual',
      servicePeriodConfirmed: true,
    };
    const client = {
      rpc: async (name: string) =>
        name === 'pull_workspace_invoices'
          ? { data: [row], error: null }
          : { data: null, error: { message: 'im Test nicht vorgesehen' } },
    } as never;

    const result = await applyInvoicePullAfterVorgangMerge({
      workspaceId: 'ws-1',
      vorgaenge: [createTestVorgang({ invoices: [lokalerStand] })],
      report: createEmptySyncSimulationReport(),
      client,
      alignForMember,
    });
    expect(result.invoiceRpcFailed).toBe(false);
    return result.vorgaenge[0]!.invoices.find((invoice) => invoice.id === 'inv-gls01-pull')!;
  }

  it('P2: mit Schalter gilt auf dem Mitgliedsgerät der Cloud-Stand', async () => {
    const invoice = await ziehe(true);
    expect(invoice.status).toBe('vorbereitet');
    expect(invoice.sentAt).toBeUndefined();
    expect(invoice.servicePeriodConfirmed).toBe(false);
  });

  it('P3: ohne Schalter bleibt der monotone Merge für Inhaber und Verwaltung unverändert', async () => {
    const invoice = await ziehe(false);
    expect(invoice.status).toBe('versendet');
    expect(invoice.sentAt).toBe('2026-08-01');
    expect(invoice.servicePeriodConfirmed).toBe(true);
  });
});
