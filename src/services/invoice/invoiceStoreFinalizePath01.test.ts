/**
 * FIRST-CLASS-LOCAL-INVOICE-STORE-01B2 — der echte Weg einer Rechnung.
 *
 * Die bestehenden Archiv-, Versand- und Ablauf-Suiten brechen seit
 * `INVOICE-SERVICE-PERIOD-01B` an ihren Fixtures ab: Sie setzen einen gültigen
 * Leistungszeitraum, aber keine Bestätigung, und erreichen den Speicherpfad
 * deshalb gar nicht. Damit wäre unbelegt, ob der Umbau ihn beschädigt hat.
 *
 * Diese Suite geht denselben Weg mit einem **vollständigen** Entwurf: Freigabe,
 * Archivierung, Versand, Speichern und Neuladen — alles über die tatsächlichen
 * Produktionsfunktionen, nicht über den Speicher direkt.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getInvoiceStoreSnapshot } from './invoiceStore';
import { listInvoices } from './invoiceRegistryService';
import { buildAbschlagDraft, finalizeInvoiceDraft } from '../invoiceService';
import { getDocumentByLinkedInvoiceId } from '../documentService';
import { markInvoiceAsSent } from '../invoiceSentService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  persistAll,
  resetBusinessStateWriteLocksForTests,
} from '../persistenceService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateDocumentStore } from '../documentService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InvoiceDraft } from '../../types/models';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Speicher GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
};

/**
 * Ein freigabefähiger Entwurf: Menge gesetzt **und** Leistungszeitraum
 * bestätigt. Genau die Bestätigung fehlt den bestehenden Fixtures.
 */
function buildApprovableDraft(): InvoiceDraft {
  const draft = buildAbschlagDraft('v-test-1', testSetup);
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();
  return {
    ...draft!,
    positions: draft!.positions.map((p) => ({ ...p, quantity: 4 })),
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    servicePeriodConfirmed: true,
  };
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope({ type: 'guest' });
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-test-1',
      orderPositions: [createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, unitPrice: 65 })],
    }),
  ]);
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B2 — Freigabe bis Neuladen', () => {
  it('F1: eine freigegebene Rechnung landet zentral und am Vorgang', () => {
    const result = finalizeInvoiceDraft('v-test-1', buildApprovableDraft(), testSetup);

    expect(
      result.ok,
      result.ok ? '' : `${result.reason}: ${JSON.stringify(result.validation?.blockingErrors)}`,
    ).toBe(true);
    if (!result.ok) return;

    expect(getInvoiceStoreSnapshot().map((e) => [e.invoice.id, e.vorgangId])).toEqual([
      [result.invoice.id, 'v-test-1'],
    ]);
    expect(listInvoices().map((i) => i.id)).toEqual([result.invoice.id]);
    expect(getVorgangById('v-test-1')?.invoices.map((i) => i.id)).toEqual([result.invoice.id]);
  });

  it('F2: die Archivverknüpfung steht am zentralen Eintrag', () => {
    const result = finalizeInvoiceDraft('v-test-1', buildApprovableDraft(), testSetup);
    if (!result.ok) throw new Error('Freigabe scheiterte');

    expect(result.invoice.archiveDocumentId).toBeTruthy();
    expect(getDocumentByLinkedInvoiceId(result.invoice.id)?.category).toBe('ausgangsrechnung');
    expect(getInvoiceStoreSnapshot()[0]?.invoice.archiveDocumentId).toBe(
      result.invoice.archiveDocumentId,
    );
    expect(getVorgangById('v-test-1')?.invoices[0]?.archiveDocumentId).toBe(
      result.invoice.archiveDocumentId,
    );
  });

  it('F3: der Versandstatus wirkt auf denselben Eintrag', () => {
    const result = finalizeInvoiceDraft('v-test-1', buildApprovableDraft(), testSetup);
    if (!result.ok) throw new Error('Freigabe scheiterte');

    const sent = markInvoiceAsSent('v-test-1', result.invoice.id, {
      sentAt: '2026-09-05',
      sentVia: 'email',
    });

    expect(sent.ok, 'Der Versand scheiterte').toBe(true);
    expect(getInvoiceStoreSnapshot()[0]?.invoice.status).toBe('versendet');
    expect(getVorgangById('v-test-1')?.invoices[0]?.sentAt).toBe('2026-09-05');
  });

  /*
   * F4 — der vollständige Kreis: Speichern, alles vergessen, neu laden. Genau
   * hier hätte ein Umbau der Ablage einen Verlust hinterlassen.
   */
  it('F4: die Rechnung überlebt Speichern und Neuladen', () => {
    const result = finalizeInvoiceDraft('v-test-1', buildApprovableDraft(), testSetup);
    if (!result.ok) throw new Error('Freigabe scheiterte');
    markInvoiceAsSent('v-test-1', result.invoice.id, { sentAt: '2026-09-05', sentVia: 'email' });

    expect(persistAll().success).toBe(true);
    const snapshot = buildPersistedStateSnapshot();
    expect(snapshot.invoiceEntries).toHaveLength(1);
    expect(snapshot.vorgaenge.flatMap((v) => v.invoices ?? []), 'Zweite Kopie').toEqual([]);

    resetTestStores();
    expect(listInvoices()).toEqual([]);

    applyStateToStores(snapshot);

    expect(listInvoices().map((i) => i.id)).toEqual([result.invoice.id]);
    const reloaded = getVorgangById('v-test-1')?.invoices[0];
    expect(reloaded?.status).toBe('versendet');
    expect(reloaded?.sentAt).toBe('2026-09-05');
    expect(reloaded?.archiveDocumentId).toBe(result.invoice.archiveDocumentId);
  });
});
