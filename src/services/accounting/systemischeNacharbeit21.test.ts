/**
 * FINANZ-CORE-01A — systemische Gesamtnacharbeit (Bericht 21): Client-Nachweise zu SYS-02 und SYS-01/03 auf
 * Clientseite, die kein Echtserver braucht. Fallnummern wie festgelegt (belege/systemisch/abnahmefaelle.json).
 *
 *  T4-01 Schreibfehler beim Abschließen/Wiederöffnen: nichts angelegt oder geändert, nichts eingereiht, Sperre
 *  T4-03 beschädigter Vermerk-Inhalt: eine Zahlung ohne Serverbestätigung sperrt im Cloudbetrieb trotzdem
 *  T4-04 Neustart zwischen lokalem Buchen und Serverantwort: weiter unbestätigt; der vollständige Nachgleich bestätigt
 *  T4-05 Betriebswechsel: Zahlungszeilen eines anderen Betriebs bestätigen nichts
 *  D9    Paket aus einem Datenstand: Änderung während des Ladens → nichts ausgegeben; Paket zitiert die
 *        Serverrevision und den Datenstand; ausdrücklich lokale Übergabe gekennzeichnet; abgewiesen → nichts
 *  D7    Sendeweg: Annahme mit Serverbestätigung; fachliche Abweisung endgültig an der Revision; Rechteabweisung
 *        bewusst erneut sendbar; Netzfehler bleibt ausstehend
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import * as sb from '../../lib/supabase';
import { resetTestStores } from '../../test/resetStores';
import { abschluesseServerbestaetigt } from '../../test/accountingClosureTestUtils';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { listInvoiceEntries } from '../invoice/invoiceRegistryService';
import { setExpenseStoreForTests } from '../expenseStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { applyStateToStores, buildPersistedStateSnapshot, persistAll, resetLastPersistFailureForTests } from '../persistenceService';
import { getSyncOutboxSnapshot, isResendableDeniedOutboxEntry, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { createSupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { resetInvoicePaymentResyncForTests, resyncLocalOnlyInvoicePayments } from '../invoice/invoicePaymentCloudResyncService';
import { getUnconfirmedInvoicePaymentKeys } from '../invoice/invoicePaymentConfirmationStore';
import { pullInvoicePaymentsFromCloud } from '../invoice/workspaceInvoicePaymentCloudService';
import { setAccountingStoreForTests } from './accountingStore';
import { getActiveClosureForMonth, getClosuresForMonth, setAccountingPeriodStoreForTests } from './accountingPeriodStore';
import { closeAccountingPeriod, getAccountingPeriodState, reopenAccountingPeriod } from './accountingPeriodService';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import { buildAccountingExport } from './accountingExportRunner';
import { collectUnconfirmedFinancialSources } from './unconfirmedFinancialSources';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';
import type { AccountingAssignment } from '../../types/accounting';
import type { AppPersistedState, VorgangInvoice } from '../../types/models';

const SEP = '2026-09';
const WS = '00000000-0000-0000-0000-0000000s2101';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-sys21',
    number: 'RE-2026-2101',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    paymentDueDate: '2026-09-30',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function kontierung(accountNumber = '8400'): AccountingAssignment {
  return {
    id: 'k-inv-sys21', sourceType: 'invoice', sourceId: 'inv-sys21', chartOfAccounts: 'SKR03', accountNumber,
    accountLabel: 'Erlöse 19 %', taxTreatment: 'standard_19', bookingText: 'Beleg inv-sys21', status: 'confirmed',
    origin: 'manual', confirmedAt: '2026-09-15T10:00:00.000Z', createdAt: '2026-09-15T10:00:00.000Z', updatedAt: '2026-09-15T10:00:00.000Z',
  } as AccountingAssignment;
}

const zahlung = (id: string, cloudBestaetigt?: boolean) => ({
  id, date: '2026-09-20', amount: 50, createdAt: '2026-09-20T10:00:00.000Z', ...(cloudBestaetigt ? { cloudBestaetigt: true } : {}),
});

/** Ein Abgleich hat den Bestand bestätigt: keine offenen Sendeaufträge. */
function abgeglichen(): void {
  resetSyncOutboxForTests(getSyncOutboxSnapshot().map((entry) => ({ ...entry, status: 'completed' as const })));
}

function speicherVoll(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  });
}

const loaders: MonatsmappeDocumentLoaders = {
  invoicePdf: async () => new Uint8Array([37, 80, 68, 70, 45]),
  invoiceCorrectionPdf: async () => new Uint8Array([37, 80, 68, 70, 45]),
  fileRefBytes: async () => new Uint8Array([1, 2, 3]),
};

async function manifestAus(blob: Blob | undefined) {
  const zip = await JSZip.loadAsync(blob!);
  const root = Object.keys(zip.files)[0].split('/')[0];
  return {
    root,
    manifest: JSON.parse(await zip.file(`${root}/00_Abschluss/manifest.json`)!.async('string')) as Record<string, any>,
    pruefbericht: await zip.file(`${root}/00_Abschluss/pruefbericht.txt`)!.async('string'),
  };
}

beforeEach(() => {
  resetTestStores();
  resetLastPersistFailureForTests();
  resetInvoicePaymentResyncForTests();
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateInvoiceStore([]);
  hydrateWorkspaceStore({
    workspaceSettings: { workspaceId: WS, settings: { chartOfAccounts: 'SKR03' }, version: 1, updatedAt: '2026-09-01T10:00:00.000Z' },
  });
  vi.spyOn(sb, 'isSupabaseConfigured').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetLastPersistFailureForTests();
});

/* ================================================================== */
describe('T4 — Persistenz: nichts gilt, was nicht gespeichert ist', () => {
  it('T4-01 Schreibfehler beim Abschließen: keine Revision, kein Sendeauftrag, Sperre bis zum nächsten erfolgreichen Speichern', () => {
    hydrateInvoiceStore([{ invoice: rechnung(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    speicherVoll();
    const versuch = closeAccountingPeriod(SEP);
    expect(versuch).toEqual({ success: false, errorKey: 'accountingPeriod.persistFailed' });
    expect(getClosuresForMonth(SEP)).toEqual([]);
    expect(getSyncOutboxSnapshot().some((e) => e.entityType === 'accounting_period_closure')).toBe(false);
    expect(getAccountingPeriodState(SEP).blockers.map((b) => b.code)).toContain('persist_failed');
    expect(closeAccountingPeriod(SEP).success).toBe(false);
    vi.unstubAllGlobals();
    expect(persistAll().success).toBe(true);
    expect(getAccountingPeriodState(SEP).blockers.map((b) => b.code)).not.toContain('persist_failed');
    expect(closeAccountingPeriod(SEP).success).toBe(true);
  });

  it('T4-01b Schreibfehler beim Wiederöffnen: die Revision bleibt aktiv und unverändert', () => {
    hydrateInvoiceStore([{ invoice: rechnung(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    expect(closeAccountingPeriod(SEP).success).toBe(true);
    const vorher = getActiveClosureForMonth(SEP)!;
    speicherVoll();
    expect(reopenAccountingPeriod(SEP, { reason: 'Test' })).toEqual({ success: false, errorKey: 'accountingPeriod.persistFailed' });
    const nachher = getActiveClosureForMonth(SEP);
    expect(nachher?.id).toBe(vorher.id);
    expect(nachher?.reopenedAt).toBeUndefined();
    expect(getSyncOutboxSnapshot().filter((e) => e.entityType === 'accounting_period_closure' && e.operation === 'update')).toEqual([]);
  });

  it('T4-03 beschädigter Vermerk-Inhalt: eine Zahlung ohne Serverbestätigung sperrt im Cloudbetrieb trotzdem', () => {
    localStorage.setItem(`${'local'}:invoice-payment-unconfirmed`, '{kaputt');
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.endsWith(':invoice-payment-unconfirmed')) localStorage.setItem(key, '{kaputt');
    }
    expect(getUnconfirmedInvoicePaymentKeys().size).toBe(0);
    const quellen = collectUnconfirmedFinancialSources(SEP, {
      outbox: [], expenses: [], employeePayments: [], assignments: [],
      invoices: [rechnung({ payments: [zahlung('pay-1')] })],
      unconfirmedInvoicePayments: getUnconfirmedInvoicePaymentKeys(),
      cloudMode: true,
    });
    expect(quellen).toEqual([{ sourceType: 'invoice_payment', sourceId: 'inv-sys21', reason: 'nicht_gesichert', paymentId: 'pay-1' }]);
    // Und über die echten Dienste: der Monat sperrt, der Abschluss scheitert, das Gate gibt kein Paket frei.
    hydrateInvoiceStore([{ invoice: rechnung({ payments: [zahlung('pay-1')] }), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    expect(getAccountingPeriodState(SEP).blockers.map((b) => b.code)).toContain('unconfirmed_financial_changes');
    expect(closeAccountingPeriod(SEP).success).toBe(false);
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(false);
  });

  it('T4-04 Neustart zwischen lokalem Buchen und Serverantwort: weiter unbestätigt; der vollständige Nachgleich bestätigt', async () => {
    hydrateInvoiceStore([{ invoice: rechnung({ payments: [zahlung('pay-neu')] }), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    expect(persistAll().success).toBe(true);
    // Neustart: der gespeicherte Stand in einen frischen Speicher.
    const gespeichert = JSON.parse(JSON.stringify(buildPersistedStateSnapshot())) as AppPersistedState;
    resetTestStores();
    applyStateToStores(gespeichert);
    expect(getAccountingPeriodState(SEP).blockers.map((b) => b.code)).toContain('unconfirmed_financial_changes');
    // Der Nachgleich findet die Zahlung beim Server: positive Bestätigung an der Zahlung.
    await resyncLocalOnlyInvoicePayments(
      {
        listInvoices: () => listInvoiceEntries().map((e) => e.invoice),
        pull: async () => ({ outcome: 'synced', rows: [{ clientInvoiceId: 'inv-sys21', clientPaymentId: 'pay-neu' }] }) as never,
        push: async () => 'failed',
        now: () => Date.parse('2026-09-21T10:00:00.000Z'),
      },
      { force: true },
    );
    expect(listInvoiceEntries()[0]?.invoice.payments?.[0]?.cloudBestaetigt).toBe(true);
    expect(getAccountingPeriodState(SEP).blockers.map((b) => b.code)).not.toContain('unconfirmed_financial_changes');
  });

  it('T4-05 Betriebswechsel: Zahlungszeilen eines anderen Betriebs werden verworfen und bestätigen nichts', async () => {
    const fremd = {
      workspace_id: '00000000-0000-0000-0000-00000000f0f0', client_invoice_id: 'inv-sys21', client_payment_id: 'pay-1',
      amount: 50, paid_on: '2026-09-20', reference: null, note: null, method: 'bank', created_at: '2026-09-20T10:00:00.000Z',
      updated_at: '2026-09-20T10:00:00.000Z', row_version: 1, reversed_at: null,
    };
    const client = { rpc: async () => ({ data: [fremd], error: null }) };
    const pull = await pullInvoicePaymentsFromCloud({ client: client as never, workspaceId: WS });
    expect(pull).toEqual({ outcome: 'synced', rows: [] });
  });
});

/* ================================================================== */
describe('D9 — Übergabepaket aus einem geprüften Datenstand', () => {
  function abgeschlossen(): void {
    hydrateInvoiceStore([{ invoice: rechnung(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    expect(closeAccountingPeriod(SEP).success).toBe(true);
  }

  it('D9-1 ändert sich der Bestand während des Ladens, wird nichts ausgegeben', async () => {
    abgeschlossen();
    abschluesseServerbestaetigt();
    const aendernd: MonatsmappeDocumentLoaders = {
      ...loaders,
      invoicePdf: async () => {
        setAccountingStoreForTests([kontierung('8401')]);
        return new Uint8Array([37, 80, 68, 70, 45]);
      },
    };
    const { result, blob } = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders: aendernd });
    expect(result).toEqual({ outcome: 'changed_during_export' });
    expect(blob).toBeUndefined();
  });

  it('D9-2 reguläres Paket zitiert die angenommene Serverrevision und ihren Datenstand', async () => {
    abgeschlossen();
    abschluesseServerbestaetigt();
    const { result, blob } = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders });
    expect(result.outcome).toBe('exported');
    const { root, manifest, pruefbericht } = await manifestAus(blob);
    expect(root).not.toContain('lokal');
    expect(manifest.version).toBe(3);
    expect(manifest.abschlussCloud).toEqual({
      status: 'angenommen', cloudBestaetigt: true, uebergabeArt: 'regulaer', fingerprintVersion: 6,
      serverRevision: 1, datenstand: 1, validiertAm: getActiveClosureForMonth(SEP)!.closedAt,
    });
    expect(pruefbericht).toContain('vom Server geprüft und angenommen (Serverrevision 1, Datenstand 1, Fassung 6)');
  });

  it('D9-3 ohne Serverannahme: kein reguläres Paket; ausdrücklich lokale Übergabe gekennzeichnet, ohne Serverangaben', async () => {
    abgeschlossen();
    const regulaer = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders });
    expect(regulaer.result.outcome).toBe('blocked');
    const lokal = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders, handover: 'lokal' });
    expect(lokal.result.outcome).toBe('exported');
    if (lokal.result.outcome === 'exported') expect(lokal.result.fileName).toContain('_lokal-nicht-cloudbestaetigt');
    const { manifest, pruefbericht } = await manifestAus(lokal.blob);
    expect(manifest.abschlussCloud).toEqual({
      status: 'ausstehend', cloudBestaetigt: false, uebergabeArt: 'lokal', fingerprintVersion: 6,
      serverRevision: null, datenstand: null, validiertAm: null,
    });
    expect(pruefbericht).toContain('NICHT CLOUDBESTÄTIGT');
  });

  it('D9-4 Betrieb ohne Cloud: reguläres Paket als lokaler Abschluss gekennzeichnet', async () => {
    vi.spyOn(sb, 'isSupabaseConfigured').mockReturnValue(false);
    abgeschlossen();
    const { result, blob } = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders });
    expect(result.outcome).toBe('exported');
    const { manifest, pruefbericht } = await manifestAus(blob);
    expect(manifest.abschlussCloud).toMatchObject({ status: 'lokal', cloudBestaetigt: false, uebergabeArt: 'lokal', serverRevision: null });
    expect(pruefbericht).toContain('lokaler Abschluss (Betrieb ohne Cloud)');
  });
});

/* ================================================================== */
describe('D7 — Sendeweg des Abschlusses: bestätigt, abgewiesen, ausstehend', () => {
  async function senden(antwort: (name: string) => { data: unknown; error: { message: string } | null } | Promise<never>) {
    const snapshot = buildPersistedStateSnapshot();
    const state = { ...snapshot, syncClient: { ...snapshot.syncClient, deviceId: 'B', workspaceId: WS, serverWorkspaceId: WS } } as AppPersistedState;
    const rpc = vi.fn(async (name: string) => antwort(name));
    const push = await createSupabaseSyncAdapter({ rpc } as never).pushChanges({ state, outbox: state.syncOutbox ?? [], deviceId: 'B', workspaceId: WS });
    applyStateToStores(push.state);
    return push;
  }

  function vorbereitet(): string {
    hydrateInvoiceStore([{ invoice: rechnung(), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    const r = closeAccountingPeriod(SEP);
    if (!r.success) throw new Error(r.errorKey);
    return r.closure.id;
  }

  it('D7-1 Annahme mit Serverbestätigung → „angenommen“, reguläres Paket frei', async () => {
    const id = vorbereitet();
    const fp = getActiveClosureForMonth(SEP)!.fingerprint;
    await senden(() => ({
      data: { revision: 3, row_version: 1, noop: false, fingerprint: fp, validated_version: 6, finance_revision: 77, validated_at: '2026-10-01T10:00:00.000Z' },
      error: null,
    }));
    expect(getActiveClosureForMonth(SEP)?.server).toEqual({ revision: 3, fingerprint: fp, validiert: true, datenstand: 77, bestaetigtAm: '2026-10-01T10:00:00.000Z' });
    expect(getAccountingPeriodState(SEP).revisionStatus?.[id]).toBe('angenommen');
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(true);
  });

  it('D7-2 Antwort ohne Prüfnachweis (alter Server) → keine Bestätigung, ausstehend', async () => {
    vorbereitet();
    await senden(() => ({ data: { revision: 1, row_version: 1, noop: false }, error: null }));
    expect(getActiveClosureForMonth(SEP)?.server).toBeUndefined();
    expect(getAccountingPeriodState(SEP).activeClosureStatus).toBe('historisch');
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(false);
  });

  it('D7-3 fachliche Abweisung → endgültig an der Revision, nie automatisch erneut, Monat wieder abschließbar', async () => {
    const id = vorbereitet();
    const push = await senden(() => ({ data: null, error: { message: 'closure_manifest_mismatch: fehlend=1 erfunden=0 abweichend=0 doppelt=0 kopf=0; fehlend E|invoice|x|ausgangsrechnung' } }));
    const auftrag = getSyncOutboxSnapshot().find((e) => e.entityType === 'accounting_period_closure')!;
    expect(push.failedOutbox[0]?.retryable).toBe(false);
    expect(auftrag.status).toBe('failed');
    expect(isResendableDeniedOutboxEntry(auftrag)).toBe(false);
    const state = getAccountingPeriodState(SEP);
    expect(state.activeClosure).toBeNull();
    expect(state.revisionStatus?.[id]).toBe('abgewiesen');
    expect(state.revisionHistory[0]?.cloudAbweisung?.meldung).toContain('closure_manifest_mismatch');
    // Ein erneuter Lauf sendet nichts.
    const nochmal = await senden(() => {
      throw new Error('darf nicht gesendet werden');
    });
    expect(nochmal.failedOutbox).toEqual([]);
    expect(closeAccountingPeriod(SEP).success).toBe(true);
  });

  it('D7-4 Rechteabweisung → Abschluss bleibt sichtbar, „abgewiesen“, bewusst erneut sendbar', async () => {
    const id = vorbereitet();
    await senden(() => ({ data: null, error: { message: 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht' } }));
    const auftrag = getSyncOutboxSnapshot().find((e) => e.entityType === 'accounting_period_closure')!;
    expect(auftrag.status).toBe('failed');
    expect(isResendableDeniedOutboxEntry(auftrag)).toBe(true);
    const state = getAccountingPeriodState(SEP);
    expect(state.activeClosure?.id).toBe(id);
    expect(state.activeClosure?.cloudAbweisung).toBeUndefined();
    expect(state.activeClosureStatus).toBe('abgewiesen');
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(false);
  });

  it('D7-5 Netzfehler → wiederholbar, „ausstehend“, kein reguläres Paket, ausdrücklich lokale Übergabe möglich', async () => {
    vorbereitet();
    await senden(() => {
      throw new TypeError('Failed to fetch');
    });
    const auftrag = getSyncOutboxSnapshot().find((e) => e.entityType === 'accounting_period_closure')!;
    expect(auftrag.status).toBe('error');
    expect(getAccountingPeriodState(SEP).activeClosureStatus).toBe('ausstehend');
    const gate = evaluateAccountingExportReadiness(SEP);
    expect(gate.packageAllowed).toBe(false);
    expect(gate.localHandoverAllowed).toBe(true);
  });
});

/* ================================================================== */
describe('T3-09 — unvollständige Abzugsantworten sind Abzugsfehler, kein leerer Bestand', () => {
  it('Ausgaben, Mitarbeiterdaten, Kontierungen und Abschlüsse: eine fehlende oder falsch geformte Liste bricht ab', async () => {
    const { rpcPullWorkspaceExpenses } = await import('../expense/expenseCloudSyncService');
    const { rpcPullWorkspaceEmployeeData } = await import('../employee/employeeCloudSyncService');
    const { rpcPullWorkspaceAccountingAssignments } = await import('./accountingCloudSyncService');
    const { rpcPullWorkspaceAccountingPeriodClosures } = await import('./accountingPeriodCloudSyncService');
    const antwort = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as never;
    await expect(rpcPullWorkspaceExpenses(WS, antwort({ expenses: [] }))).rejects.toThrow('pull_incomplete');
    await expect(rpcPullWorkspaceExpenses(WS, antwort({ expenses: {}, payments: [] }))).rejects.toThrow('pull_incomplete');
    await expect(rpcPullWorkspaceEmployeeData(WS, antwort({ employees: [] }))).rejects.toThrow('pull_incomplete');
    await expect(rpcPullWorkspaceAccountingAssignments(WS, antwort(null))).rejects.toThrow('pull_incomplete');
    await expect(rpcPullWorkspaceAccountingPeriodClosures(WS, antwort({ closures: 'kaputt' }))).rejects.toThrow('pull_incomplete');
    // Vollständige (auch leere) Antworten bleiben gültig.
    await expect(rpcPullWorkspaceExpenses(WS, antwort({ expenses: [], payments: [] }))).resolves.toEqual({ expenses: [], payments: [] });
    await expect(rpcPullWorkspaceAccountingPeriodClosures(WS, antwort({ closures: [] }))).resolves.toEqual({ closures: [] });
  });
});

/* ================================================================== */
describe('SYS-03 — kumulierte offene Posten sind an die Revision gebunden', () => {
  it('T8-05 eine nachträglich erfasste Vorperiodenzahlung macht den Abschluss eines späteren Monats ungültig; eine Altfassung (v4) merkte es nicht', async () => {
    const { buildPeriodFingerprint, buildPeriodManifest } = await import('./accountingPeriodFingerprint');
    const { buildAccountingPeriodState } = await import('./accountingPeriodService');
    const { buildMonatsmappeModel } = await import('../steuerberater/monatsmappeModelService');
    const { collectMonatsmappeInput } = await import('../steuerberater/monatsmappeInputService');
    const augustRechnung = (payments: VorgangInvoice['payments']) =>
      rechnung({ date: '2026-08-10', issueDate: '2026-08-10', paymentDueDate: '2026-09-30', payments });
    hydrateInvoiceStore([{ invoice: augustRechnung([]), vorgangId: null }]);
    setAccountingStoreForTests([kontierung()]);
    abgeglichen();
    // September ohne eigene Belege, aber mit der offenen Augustrechnung.
    expect(closeAccountingPeriod(SEP).success).toBe(true);
    const sep = getActiveClosureForMonth(SEP)!;
    expect(sep.manifest.offenePosten).toEqual([
      { belegart: 'ausgangsrechnung', belegId: 'inv-sys21', datum: '2026-08-10', brutto: 119, bezahlt: 0, offen: 119, faelligAm: '2026-09-30' },
    ]);
    const v4 = buildPeriodManifest(buildMonatsmappeModel(collectMonatsmappeInput(SEP)), [kontierung()], 'SKR03', 4);
    const v4Abschluss = { ...sep, id: 'alt-v4', fingerprint: buildPeriodFingerprint(v4), manifest: v4 };
    // Nachträglich erfasst: eine Zahlung vom 20.08. (Vorperiode des Septembers), vom Server bestätigt.
    hydrateInvoiceStore([{ invoice: augustRechnung([{ id: 'pay-vor', date: '2026-08-20', amount: 119, createdAt: '2026-10-02T10:00:00.000Z', cloudBestaetigt: true }]), vorgangId: null }]);
    expect(getAccountingPeriodState(SEP).readiness).toBe('changed_after_close');
    expect(evaluateAccountingExportReadiness(SEP).packageBlockers.map((b) => b.code)).toContain('changed_after_close');
    // Zum Vergleich: die Altfassung band die offenen Posten nicht und hielte den Abschluss für gültig.
    const alt = buildAccountingPeriodState(buildMonatsmappeModel(collectMonatsmappeInput(SEP)), [kontierung()], 'SKR03', [v4Abschluss]);
    expect(alt.isCurrentClosureValid).toBe(true);
  });
});
