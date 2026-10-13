/**
 * FINANZ-CORE-01A — die Client-Seite der neuen Serververträge.
 *
 *  - SQL-04: Nach einer wirksamen Schlussrechnung entsteht keine weitere
 *    Rechnung; der lokale Wächter meldet es vor `begin`.
 *  - SQL-01: Ein früherer Beleg ist erst nach dem Storno der Schlussrechnung
 *    stornierbar; die Vorprüfung ruft den Server gar nicht erst.
 *  - Fehlercodes und Meldungen: keine allgemeine „Freigabe fehlgeschlagen".
 *  - ANG-01: Ein Angebot ohne Steuerentscheidung ist nicht freigebbar.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VorgangInvoice } from '../../types/models';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { hydrateVorgangStore } from '../vorgangService';
import {
  findConflictingFinalInvoice,
  findFinalInvoiceBlockingNewInvoice,
  findLocalFinalInvoiceConflict,
} from './invoiceFinalizationCoordinator';
import { cancelFinalizedInvoice } from './invoiceCancellationService';
import { findFinalInvoiceBlockingCancel } from './invoiceCancelEligibility';
import * as cloudService from './workspaceInvoiceCloudService';
import * as invoiceSent from '../invoiceSentService';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';
import { addOfferDraft, buildOfferFinalizationCandidate, resetOffers } from '../offer/offerService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';

const VORGANG = 'v-fc01a';

function schluss(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 6, {
    id: 'inv-schluss',
    number: '2026-0003',
    type: 'schluss',
    abschlagNumber: undefined,
    ...overrides,
  });
}

const abschlag = createAbschlagInvoice('op-test-1', 4, { id: 'inv-abschlag', number: '2026-0001' });
const teil = createAbschlagInvoice('op-test-1', 2, {
  id: 'inv-teil',
  number: '2026-0002',
  type: 'teilrechnung',
  abschlagNumber: undefined,
});
const storniert = { cancelledAt: '2026-10-01T08:00:00.000Z', paymentStatus: 'storniert' as const };

function seed(invoices: VorgangInvoice[]): void {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, invoices })]);
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('SQL-04 — nach der Schlussrechnung keine weitere Rechnung', () => {
  it('N1: eine wirksame Schlussrechnung blockiert Abschlag, Teilrechnung und Rechnung', () => {
    for (const type of ['abschlag', 'teilrechnung', 'rechnung'] as VorgangInvoice['type'][]) {
      expect(findFinalInvoiceBlockingNewInvoice([schluss()], type, 'inv-neu')?.id, type).toBe('inv-schluss');
    }
  });

  it('N2: eine stornierte Schlussrechnung blockiert nichts; die zweite Schlussrechnung bleibt beim 01D-Wächter', () => {
    expect(findFinalInvoiceBlockingNewInvoice([schluss(storniert)], 'abschlag', 'inv-neu')).toBeNull();
    expect(findFinalInvoiceBlockingNewInvoice([schluss()], 'schluss', 'inv-neu')).toBeNull();
    expect(findConflictingFinalInvoice([schluss()], 'schluss', 'inv-neu')?.id).toBe('inv-schluss');
  });

  it('N3: der lokale Wächter vor begin sieht den Rechnungsspeicher (Produktionsweg)', () => {
    seed([abschlag, schluss()]);
    expect(findLocalFinalInvoiceConflict(VORGANG, 'abschlag', 'inv-neu')?.id).toBe('inv-schluss');
    seed([abschlag, schluss(storniert)]);
    expect(findLocalFinalInvoiceConflict(VORGANG, 'abschlag', 'inv-neu')).toBeNull();
  });
});

describe('SQL-01 — früherer Beleg erst nach Storno der Schlussrechnung', () => {
  it('C1: Abschlag und Teilrechnung sind durch die wirksame Schlussrechnung gesperrt', () => {
    seed([abschlag, teil, schluss()]);
    expect(findFinalInvoiceBlockingCancel(VORGANG, abschlag)?.number).toBe('2026-0003');
    expect(findFinalInvoiceBlockingCancel(VORGANG, teil)?.id).toBe('inv-schluss');
    // Die Schlussrechnung selbst bleibt stornierbar, die freie Rechnung kennt keine.
    expect(findFinalInvoiceBlockingCancel(VORGANG, schluss())).toBeNull();
    expect(findFinalInvoiceBlockingCancel(null, abschlag)).toBeNull();
  });

  it('C2: nach dem Storno der Schlussrechnung ist der frühere Beleg wieder stornierbar', () => {
    seed([abschlag, schluss(storniert)]);
    expect(findFinalInvoiceBlockingCancel(VORGANG, abschlag)).toBeNull();
  });

  it('C3: die Vorprüfung meldet final_invoice_exists, ohne den Server zu rufen', async () => {
    seed([abschlag, schluss()]);
    const rpc = vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice');
    const result = await cancelFinalizedInvoice({ vorgangId: VORGANG, invoiceId: 'inv-abschlag', reason: 'Falsch' });
    expect(result).toEqual({ ok: false, reason: 'final_invoice_exists' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('Fehlercodes und Meldungen', () => {
  it('E1: der Server-Code nach der Schlussrechnung ist derselbe fachliche Ausgang wie 01D', () => {
    expect(classifyInvoiceCloudErrorForTests({ message: 'invoice_after_final_invoice' }).code).toBe('final_invoice_exists');
    expect(classifyInvoiceCloudErrorForTests({ message: 'invoice_cancel_final_invoice_exists' }).code).toBe(
      'cancel_final_invoice_exists',
    );
  });

  it('E2: Schlussrechnung vorhanden und Duplikat haben eigene, handlungsleitende Meldungen', () => {
    const base = { ok: false as const, recovery: 'blocked' as const, cloudState: 'not_committed' as const };
    expect(mapFinalizationFailureToUx({ ...base, reason: 'final_invoice_exists' }).messageKey).toBe(
      'invoice.approve.finalInvoiceExists',
    );
    expect(mapFinalizationFailureToUx({ ...base, reason: 'possible_existing_invoice' }).messageKey).toBe(
      'invoice.approve.possibleDuplicate',
    );
    expect(mapFinalizationFailureToUx({ ...base, reason: 'conflict' }).messageKey).toBe('invoice.approve.conflict');
  });
});

describe('ANG-01 — Angebot ohne Steuerentscheidung', () => {
  beforeEach(() => {
    resetOffers();
    resetCompanyProfile();
    hydrateCompanyProfileStore({ ...createCompanyProfileFromSetup(DEFAULT_SETUP), companyName: 'Beispiel GmbH' });
  });

  function angebot(taxStatus: 'unclear' | 'standard_19') {
    const r = addOfferDraft('ws-fc01a', {
      customerId: 'cust-1',
      customer: { name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
      title: 'Dach',
      baustelle: '',
      positions: [{ id: 'p1', description: 'Dach', quantity: 1, unit: 'Stück', unitPrice: 100 }],
      taxStatus,
      offerDate: '2026-10-11',
      validUntil: '2026-11-11',
      introText: '',
      closingText: '',
      paymentTermsText: '',
    });
    if (!r.success) throw new Error(r.errorKey);
    return r.offer;
  }

  it('O1: „noch unklar" sperrt die Freigabe mit eigenem Grund', () => {
    const candidate = buildOfferFinalizationCandidate(angebot('unclear').id);
    expect(candidate.ok).toBe(false);
    expect(candidate.ok ? [] : candidate.blockers).toContain('tax_status_unclear');
  });

  it('O2: mit Steuerentscheidung keine Sperre aus diesem Grund', () => {
    const candidate = buildOfferFinalizationCandidate(angebot('standard_19').id);
    expect(candidate.ok ? [] : candidate.blockers).not.toContain('tax_status_unclear');
  });
});

describe('STO-02 — Storno einer versendeten Rechnung erst mit Versandvermerk in der Cloud', () => {
  const versendet = createAbschlagInvoice('op-test-1', 2, {
    id: 'inv-versendet',
    number: '2026-0009',
    type: 'rechnung',
    abschlagNumber: undefined,
    status: 'versendet',
    sentAt: '2026-10-02',
    sentVia: 'email',
  });

  async function storno() {
    return cancelFinalizedInvoice({
      vorgangId: VORGANG,
      invoiceId: 'inv-versendet',
      reason: 'Falsch',
      actor: { userId: 'u-1', cloudConfigured: true },
    });
  }

  it('V1: unklarer Cloud-Stand — kein Storno, kein Serveraufruf', async () => {
    seed([versendet]);
    vi.spyOn(invoiceSent, 'readInvoiceSentStateFromCloud').mockResolvedValue({ kind: 'unknown' });
    const rpc = vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice');
    expect(await storno()).toEqual({ ok: false, reason: 'sent_not_synced' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('V2: offener Vermerk wird zuerst gesichert; scheitert das, wird nicht storniert', async () => {
    seed([versendet]);
    vi.spyOn(invoiceSent, 'readInvoiceSentStateFromCloud').mockResolvedValue({ kind: 'pending' });
    const push = vi.spyOn(invoiceSent, 'syncInvoiceSentToCloud').mockResolvedValue('failed');
    const rpc = vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice');
    expect(await storno()).toEqual({ ok: false, reason: 'sent_not_synced' });
    expect(push).toHaveBeenCalledWith(VORGANG, 'inv-versendet', { userId: 'u-1', cloudConfigured: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('V3: offener Vermerk gesichert — erst dann geht das Storno an den Server', async () => {
    seed([versendet]);
    const reihenfolge: string[] = [];
    vi.spyOn(invoiceSent, 'readInvoiceSentStateFromCloud').mockImplementation(async () => {
      reihenfolge.push('lesen');
      return { kind: 'pending' };
    });
    vi.spyOn(invoiceSent, 'syncInvoiceSentToCloud').mockImplementation(async () => {
      reihenfolge.push('sichern');
      return 'synced';
    });
    vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice').mockImplementation(async () => {
      reihenfolge.push('stornieren');
      throw new cloudService.WorkspaceInvoiceCloudError('Failed to fetch', 'network', true);
    });
    await storno();
    expect(reihenfolge).toEqual(['lesen', 'sichern', 'stornieren']);
  });
});

describe('RE-07 — vorhersehbare Ablehnungen im Auftragsweg', () => {
  it('T1: nur ein entschiedener Auftrag gibt den Steuerstatus vor', async () => {
    const { orderTaxStatusLock } = await import('./invoiceApprovalUx');
    expect(orderTaxStatusLock('standard_7')).toBe('standard_7');
    expect(orderTaxStatusLock('unclear')).toBeNull();
    expect(orderTaxStatusLock(undefined)).toBeNull();
  });

  it('T2: Empfängername wie der Server — Auftrag oder Kundenstamm, sonst nichts', async () => {
    const { customerNameMatchesOrder } = await import('./invoiceApprovalUx');
    expect(customerNameMatchesOrder('Muster GmbH', 'Muster GmbH', null)).toBe(true);
    expect(customerNameMatchesOrder('Muster GmbH & Co. KG', 'Muster GmbH', 'Muster GmbH & Co. KG')).toBe(true);
    expect(customerNameMatchesOrder('Fremde AG', 'Muster GmbH', 'Muster GmbH & Co. KG')).toBe(false);
    // Ohne Namen im Auftrag prüft der Server nichts.
    expect(customerNameMatchesOrder('Fremde AG', '', null)).toBe(true);
  });
});

describe('Storno in der Sync-Warteschlange (App-Befund: Korrekturbeleg ging durch einen laufenden Sync-Lauf verloren)', () => {
  it('Q1: ein laufender Sync-Lauf hält den Storno an; erst danach geht er an den Server', async () => {
    const { runQueuedSyncOperation, resetSyncOperationQueueForTests } = await import('../sync/syncOperationQueue');
    resetSyncOperationQueueForTests();
    seed([createAbschlagInvoice('op-test-1', 2, { id: 'inv-q1', number: '2026-0021', type: 'rechnung', abschlagNumber: undefined })]);
    const reihenfolge: string[] = [];
    let freigeben!: () => void;
    const laufenderSync = runQueuedSyncOperation(async () => {
      reihenfolge.push('sync-start');
      await new Promise<void>((resolve) => {
        freigeben = resolve;
      });
      reihenfolge.push('sync-ende');
    });
    vi.spyOn(cloudService, 'rpcCancelWorkspaceInvoice').mockImplementation(async () => {
      reihenfolge.push('storno');
      throw new cloudService.WorkspaceInvoiceCloudError('Failed to fetch', 'network', true);
    });
    const workspacePayload = await import('../workspace/workspaceSyncPayloadService');
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue('ws-q1');

    const storno = cancelFinalizedInvoice({ vorgangId: VORGANG, invoiceId: 'inv-q1', reason: 'Test' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reihenfolge).toEqual(['sync-start']);
    freigeben();
    await laufenderSync;
    await storno;
    expect(reihenfolge).toEqual(['sync-start', 'sync-ende', 'storno']);
  });
});
