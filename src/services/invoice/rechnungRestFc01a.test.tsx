/**
 * FINANZ-CORE-01A — RE-Reste.
 *
 *  R7   offene Auftragsänderungen: ein Abgleich, danach „vorgang_not_synced" — nichts begonnen
 *  R7b  übertragen sie sich im Abgleich, geht die Vorbereitung weiter
 *  R12  hängt der Abgleich, endet die Vorbereitung nach der Frist mit „prep_timeout"
 *  R16  Auftragsbezeichnung nur mit Auftrag; kein Dauerhinweis „Skonto"; validation_failed nennt
 *       den ersten Prüfgrund; Zahlungsziel-Hinweis ohne „Auftrag" bei der freien Rechnung
 *  R17  steuerfrei ohne Rechtsgrundlage → Hinweis, mit § → keiner; Kleinunternehmer-Widerspruch → Hinweis
 *
 * Synthetische Daten, kein Netz.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceDraftEditForm } from '../../components/invoice/InvoiceDraftEditForm';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftRecord } from '../../types/invoiceDraftDurability';
import type { SyncOutboxEntry } from '../../types/sync';
import { buildInvoiceDraftForType } from '../invoiceService';
import { validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import * as syncUi from '../sync/syncUiService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { prepareInvoiceDraftCloudForFinalization } from './invoiceDraftCloudFinalizePrep';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';

const VORGANG_ID = 'v-test-1';

function seed(): void {
  hydrateVorgangStore([
    createTestVorgang({ orderPositions: [createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, unitPrice: 65 })] }),
  ]);
}

function entwurf(): InvoiceDraft {
  seed();
  const base = buildInvoiceDraftForType(VORGANG_ID, testSetup, 'rechnung');
  if (!base) throw new Error('Entwurf fehlt');
  return {
    ...base,
    companySnapshot: {
      ...base.companySnapshot,
      companyName: 'Muster GmbH',
      street: 'Musterallee 5',
      zip: '30000',
      city: 'Musterstadt',
      taxNumber: '133/8150/8159',
    },
  };
}

const RECORD = { vorgangId: VORGANG_ID } as unknown as InvoiceDraftRecord;

function offeneAuftragsaenderung(): SyncOutboxEntry {
  return {
    id: 'out-vorgang-offen',
    entityType: 'vorgang',
    entityId: VORGANG_ID,
    operation: 'update',
    version: 2,
    queuedAt: '2026-10-12T08:00:00.000Z',
    retryCount: 0,
    status: 'pending',
  };
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  vi.restoreAllMocks();
  resetSyncOutboxForTests([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSyncOutboxForTests([]);
});

describe('RE-07 / RE-12 — Vorbereitung vor dem Start', () => {
  it('R7: offene Auftragsänderungen werden zuerst übertragen; bleiben sie offen, beginnt nichts', async () => {
    const lauf = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue(undefined as never);
    resetSyncOutboxForTests([offeneAuftragsaenderung()]);
    const r = await prepareInvoiceDraftCloudForFinalization(RECORD, entwurf());
    expect(r).toEqual({ ok: false, reason: 'vorgang_not_synced' });
    expect(lauf).toHaveBeenCalledTimes(1);
  });

  it('R7b: überträgt der Abgleich die Änderung, geht die Vorbereitung weiter', async () => {
    vi.spyOn(syncUi, 'runSyncFromUi').mockImplementation(async () => {
      resetSyncOutboxForTests([]);
      return undefined as never;
    });
    resetSyncOutboxForTests([offeneAuftragsaenderung()]);
    const r = await prepareInvoiceDraftCloudForFinalization(RECORD, entwurf());
    expect(r.ok ? 'ok' : r.reason).not.toBe('vorgang_not_synced');
    expect(r.ok ? 'ok' : r.reason).not.toBe('prep_timeout');
    expect(getSyncOutboxSnapshot().filter((e) => e.entityType === 'vorgang')).toEqual([]);
  });

  it('R7c: ein endgültig abgewiesener Auftrag (failed) hält die Freigabe nicht auf', async () => {
    const lauf = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue(undefined as never);
    resetSyncOutboxForTests([{ ...offeneAuftragsaenderung(), status: 'failed', lastErrorRetryable: false }]);
    const r = await prepareInvoiceDraftCloudForFinalization(RECORD, entwurf());
    expect(r.ok ? 'ok' : r.reason).not.toBe('vorgang_not_synced');
    // Der Abgleich wegen des Auftrags entfällt; ein späterer für den Entwurf ist zulässig.
    expect(lauf.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('R12: hängt der Abgleich, endet die Vorbereitung nach der Frist — es hat nichts begonnen', async () => {
    vi.spyOn(syncUi, 'runSyncFromUi').mockReturnValue(new Promise(() => undefined) as never);
    resetSyncOutboxForTests([offeneAuftragsaenderung()]);
    const r = await prepareInvoiceDraftCloudForFinalization(RECORD, entwurf(), { deadlineMs: 20 });
    expect(r).toEqual({ ok: false, reason: 'prep_timeout' });
  });
});

describe('RE-16 / RE-17 — Hinweise je Rechnungsweg und Plausibilität', () => {
  const warnungen = (draft: InvoiceDraft, mitAuftrag = true) =>
    validateInvoiceDraftForApproval(draft, draft.companySnapshot, mitAuftrag ? getVorgangById(VORGANG_ID) : undefined, {
      reverseCharge13bConfirmed: true,
    }).warnings.map((w) => w.code);

  it('R16: „Auftragsbezeichnung" nur mit Auftrag ohne Titel; kein Dauerhinweis „Skonto"', () => {
    const draft = entwurf();
    expect(warnungen(draft, false)).not.toContain('vorgang_title');
    hydrateVorgangStore([createTestVorgang({ title: '  ', orderPositions: [createOrderPosition()] })]);
    expect(warnungen(draft, true)).toContain('vorgang_title');
    const ohneSkonto = { ...draft, companySnapshot: { ...draft.companySnapshot, skontoEnabled: false, defaultSkonto: '' } };
    expect(warnungen(ohneSkonto)).not.toContain('skonto');
  });

  it('R16: validation_failed nennt den ersten Prüfgrund, sonst die Sammelmeldung', () => {
    const basis = { ok: false as const, reason: 'validation_failed' as const, recovery: 'retry_allowed' as const, cloudState: 'not_committed' as const };
    expect(mapFinalizationFailureToUx({ ...basis, detail: 'invoice.validation.companyTaxId' } as never)).toMatchObject({
      messageKey: 'invoice.validation.companyTaxId',
      unlock: true,
    });
    expect(mapFinalizationFailureToUx({ ...basis, detail: 'irgendwas' } as never).messageKey).toBe('invoice.approve.blocked');
    expect(mapFinalizationFailureToUx(basis as never).messageKey).toBe('invoice.approve.blocked');
  });

  it('R17: steuerfrei ohne Rechtsgrundlage → Hinweis; mit § 4 UStG → keiner', () => {
    const draft = entwurf();
    const ohne = { ...draft, taxStatus: 'tax_free' as const, companySnapshot: { ...draft.companySnapshot, taxFreeNotice: 'Die Leistung ist ohne Umsatzsteuer.' } };
    expect(warnungen(ohne)).toContain('tax_free_basis');
    const mit = { ...ohne, companySnapshot: { ...ohne.companySnapshot, taxFreeNotice: 'Steuerfreie Leistung nach § 4 Nr. 11 UStG.' } };
    expect(warnungen(mit)).not.toContain('tax_free_basis');
    expect(warnungen({ ...draft, taxStatus: 'standard_19' })).not.toContain('tax_free_basis');
  });

  it('R17: Steuerstatus gegen Kleinunternehmerregelung des Profils', () => {
    const draft = entwurf();
    const ku = { ...draft, companySnapshot: { ...draft.companySnapshot, defaultTaxStatus: 'kleinunternehmer_19' as const } };
    expect(warnungen({ ...ku, taxStatus: 'standard_19' })).toContain('tax_status_profile');
    expect(warnungen({ ...ku, taxStatus: 'kleinunternehmer_19' })).not.toContain('tax_status_profile');
    const regel = { ...draft, companySnapshot: { ...draft.companySnapshot, defaultTaxStatus: 'standard_19' as const } };
    expect(warnungen({ ...regel, taxStatus: 'kleinunternehmer_19' })).toContain('tax_status_profile');
    // §13b und steuerfrei sind Einzelfallentscheidungen — kein Widerspruch zum Profil.
    expect(warnungen({ ...regel, taxStatus: 'reverse_charge_13b' })).not.toContain('tax_status_profile');
  });
});

describe('RE-16 — Zahlungsziel-Hinweis je Rechnungsweg', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('R16: ohne Auftrag kein „Dieser Auftrag"', () => {
    const draft = { ...entwurf(), paymentDueDate: '', paymentTermsText: 'Zahlbar nach Absprache.' };
    act(() => root.render(createElement(InvoiceDraftEditForm, { draft, onChange: () => undefined, withOrder: false })));
    const hinweis = host.querySelector('[data-testid="invoice-edit-payment-due-hint"]')?.textContent ?? '';
    expect(hinweis).not.toContain('Auftrag');
    act(() => root.render(createElement(InvoiceDraftEditForm, { draft, onChange: () => undefined })));
    expect(host.querySelector('[data-testid="invoice-edit-payment-due-hint"]')?.textContent).toContain('Dieser Auftrag');
  });
});
