/**
 * MANUAL-INVOICE-CUSTOMER-IDENTITY-01B — die Kundenreferenz einer Rechnung.
 *
 * Zwei getrennte Ebenen:
 *   1. Beleginhalt (`customerSnapshot`, Positionen, Beträge …) — Fingerprint.
 *   2. Kundenrelation (`customerId`) — set-once, separat geprüft, nie aus
 *      Name/Firma/Adresse abgeleitet, nicht im Fingerprint.
 *
 * Neutrale Beispieldaten, kein Netzwerk; Supabase nur als Antwortattrappe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billingFromCustomer, createCustomer, updateCustomer } from '../customerService';
import { getCustomerById, hydrateCustomerStore } from '../customerStoreService';
import { getKundenOverview } from '../kundenOverviewService';
import { getKundenWorkspace } from '../kundenWorkspaceService';
import {
  buildInvoiceFinalizationContentFingerprint,
  buildManualInvoiceDraft,
  buildManualInvoicePosition,
  buildRechnungDraft,
  buildAbschlagDraft,
  finalizeInvoiceDraft,
} from '../invoiceService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { archiveOutgoingInvoice } from '../invoiceArchiveService';
import { updateCompanyProfile } from '../companyProfileService';
import {
  applyFinalizedInvoiceToList,
  hydrateVorgangStore,
  immutableInvoiceFingerprint,
  upsertFinalizedManualInvoice,
} from '../vorgangService';
import { resolveInvoiceCustomerId, resolveInvoiceCustomerRelation } from './invoiceCustomerRelation';
import { mergeCloudInvoicesIntoVorgaenge } from './invoiceCloudPullMergeService';
import {
  buildWorkspaceInvoiceFinalizePayload,
  mapWorkspaceInvoicePullRowToVorgangInvoice,
  parseWorkspaceInvoicePullRow,
  rpcFinalizeWorkspaceInvoice,
} from './workspaceInvoiceCloudService';
import {
  buildInvoicePayloadV1,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import { canonicalJsonStringify } from './invoicePreparedResponseProjection';
import { findInvoiceLocatorById } from './invoiceRegistryService';
import { hydrateInvoiceStore, resetInvoiceStore } from './invoiceStore';
import { resetInvoiceNumberSequence } from '../invoiceNumberService';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { CompanySetup, Customer, VorgangInvoice } from '../../types/models';

const YEAR = 2026;

const SETUP: CompanySetup = {
  ...DEFAULT_SETUP,
  companyName: 'Cirmak Haustechnik GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  setupComplete: true,
};

/** Ein Firmenprofil-Snapshot, wie er auf einer finalisierten Rechnung liegt. */
const COMPANY = {
  companyName: 'Cirmak Haustechnik GmbH',
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  contactPerson: 'Herr Cirmak',
  phone: '0201 999999',
  email: 'buero@cirmak.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

const MUELLER = {
  name: 'Müller Bau GmbH',
  contactPerson: '',
  street: 'Hauptstraße 12',
  zip: '45356',
  city: 'Essen',
  email: '',
  phone: '',
};

function newCustomer(overrides: Partial<Customer> = {}): Customer {
  const created = createCustomer({ ...MUELLER, ...overrides });
  if (!created.success) throw new Error(`Kunde nicht angelegt: ${created.errorKey}`);
  return created.customer;
}

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: `${YEAR}-0012`,
    invoiceSequenceNumber: 12,
    type: 'rechnung',
    positions: [
      { id: 'line-1', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45, lineTotal: 45 },
    ],
    subtotal: 45,
    taxStatus: 'standard_19',
    amount: 53.55,
    status: 'versendet',
    sentAt: `${YEAR}-05-05T09:00:00.000Z`,
    sentVia: 'email',
    date: `${YEAR}-05-04`,
    issueDate: `${YEAR}-05-04`,
    createdAt: `${YEAR}-05-04T09:00:00.000Z`,
    servicePeriodFrom: `${YEAR}-05-01`,
    servicePeriodTo: `${YEAR}-05-01`,
    paymentDueDate: '2999-12-31',
    paymentTermsText: '14 Tage netto',
    skontoText: '',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: MUELLER,
    companySnapshot: COMPANY,
    ...overrides,
  } as unknown as VorgangInvoice;
}

function cloudRow(inv: VorgangInvoice, vorgangId: string | null = null) {
  const payload = buildInvoicePayloadV1(inv)!;
  return {
    id: `cloud-${inv.id}`,
    workspace_id: 'ws-1',
    vorgang_id: vorgangId,
    client_invoice_id: inv.id,
    invoice_number: inv.number,
    invoice_year: YEAR,
    invoice_sequence_number: inv.invoiceSequenceNumber,
    invoice_type: inv.type,
    invoice_status: inv.status,
    payload,
    row_version: 1,
    created_at: inv.createdAt,
    updated_at: inv.createdAt,
  };
}

function mapped(inv: VorgangInvoice, vorgangId: string | null = null) {
  const row = parseWorkspaceInvoicePullRow(cloudRow(inv, vorgangId));
  if (!row) throw new Error('Fixture: Zeile ungültig');
  return mapWorkspaceInvoicePullRowToVorgangInvoice(row);
}

function preparedRequest(inv: VorgangInvoice) {
  return {
    kind: PREPARED_FINALIZE_REQUEST_KIND,
    formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
    workspaceId: 'ws-1',
    vorgangId: null,
    clientInvoiceId: inv.id,
    invoice: inv,
    invoicePayload: buildInvoicePayloadV1(inv),
    expectedResponseProjectionRawJson: canonicalJsonStringify({ ok: true }) ?? '{}',
  };
}

function withProfile(): void {
  const result = updateCompanyProfile({
    companyName: SETUP.companyName,
    street: 'Ruhrallee 5',
    zip: '45138',
    city: 'Essen',
  });
  if (!result.success) throw new Error('Profil nicht gesetzt');
}

describe('MANUAL-INVOICE-CUSTOMER-IDENTITY-01B', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceStore();
    resetInvoiceNumberSequence();
    hydrateVorgangStore([]);
    hydrateCustomerStore([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  /* ---------------- Entwurf ---------------- */

  it('T1: der freie Entwurf mit gewähltem Kunden trägt customer.id und dessen Snapshot', () => {
    const customer = newCustomer();
    const draft = buildManualInvoiceDraft(
      { customerId: customer.id, billing: billingFromCustomer(customer) },
      SETUP,
    );
    expect(draft.customerId).toBe(customer.id);
    expect(draft.customerBilling).toEqual(billingFromCustomer(customer));
    expect(draft.vorgangId).toBeNull();
  });

  it('T2: der freie Entwurf nur mit Adressdaten hat keine customerId — auch bei bekanntem Namen', () => {
    newCustomer(); // gleicher Name existiert im Stamm
    const draft = buildManualInvoiceDraft({ billing: MUELLER }, SETUP);
    expect('customerId' in draft).toBe(false);
  });

  it('T2b: eine leere Kennung wird nicht zur Referenz', () => {
    const draft = buildManualInvoiceDraft({ customerId: '   ', billing: MUELLER }, SETUP);
    expect('customerId' in draft).toBe(false);
  });

  it('T3: der Vorgangsentwurf übernimmt vorgang.customerId', () => {
    const customer = newCustomer();
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', customerId: customer.id })]);
    for (const build of [buildRechnungDraft, buildAbschlagDraft]) {
      const draft = build('v-1', SETUP);
      expect(draft?.customerId).toBe(customer.id);
    }
  });

  it('T4: ein Legacy-Vorgang ohne customerId erzeugt einen Entwurf ohne Referenz', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', customer: MUELLER.name })]);
    const draft = buildRechnungDraft('v-1', SETUP)!;
    expect('customerId' in draft).toBe(false);
  });

  /* ---------------- Finalisierung ---------------- */

  it('T5: der lokale Finalize behält customerId; Snapshot und Referenz bleiben getrennt', () => {
    withProfile();
    const customer = newCustomer();
    const draft = buildManualInvoiceDraft(
      { customerId: customer.id, billing: billingFromCustomer(customer) },
      SETUP,
    );
    draft.positions = [
      buildManualInvoicePosition({ description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45 }),
    ];
    draft.servicePeriodFrom = `${YEAR}-05-01`;
    draft.servicePeriodTo = `${YEAR}-05-01`;
    draft.servicePeriodConfirmed = true;

    const result = finalizeInvoiceDraft(null, draft, SETUP);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const stored = findInvoiceLocatorById(result.invoice.id)!;
    expect(stored.vorgangId).toBeNull();
    expect(stored.invoice.customerId).toBe(customer.id);
    expect(stored.invoice.customerSnapshot).toEqual(billingFromCustomer(customer));
    expect('customerId' in (stored.invoice.customerSnapshot ?? {})).toBe(false);
  });

  it('T6: der Cloud-Finalize-Payload behält customerId', async () => {
    const inv = invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>);
    const payload = buildWorkspaceInvoiceFinalizePayload(inv);
    expect(payload.customerId).toBe('cust-1');

    // Und die strikte Antworthülle nimmt es zurück.
    const respond = { rpc: async () => ({ data: { idempotent_replay: false, invoice: buildInvoicePayloadV1(inv), row: cloudRow(inv) }, error: null }) } as never;
    const result = await rpcFinalizeWorkspaceInvoice(
      { workspaceId: 'ws-1', vorgangId: null, clientInvoiceId: inv.id, invoice: inv },
      respond,
    );
    expect(result.invoice.customerId).toBe('cust-1');
  });

  it('T7: der Cloud-Pull behält customerId; eine Zeile ohne Feld bleibt ohne', () => {
    expect(mapped(invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>)).invoice.customerId).toBe('cust-1');
    expect('customerId' in mapped(invoice()).invoice).toBe(false);
  });

  /* ---------------- Merge-Regel ---------------- */

  it('T8–T11: die kanonische Relationsregel', () => {
    expect(resolveInvoiceCustomerRelation(undefined, undefined)).toEqual({ ok: true, customerId: undefined, filledFromRemote: false });
    expect(resolveInvoiceCustomerRelation(undefined, 'a')).toEqual({ ok: true, customerId: 'a', filledFromRemote: true });
    expect(resolveInvoiceCustomerRelation('a', undefined)).toEqual({ ok: true, customerId: 'a', filledFromRemote: false });
    expect(resolveInvoiceCustomerRelation('a', 'a')).toEqual({ ok: true, customerId: 'a', filledFromRemote: false });
    expect(resolveInvoiceCustomerRelation('a', 'b')).toEqual({ ok: false, reason: 'customer_relation_conflict', local: 'a', remote: 'b' });
    // Leerstring zählt als fehlend — er ist keine Referenz.
    expect(resolveInvoiceCustomerRelation('', 'a').ok).toBe(true);
  });

  it('T8: lokal fehlend + remote vorhanden → Wert wird übernommen (Auftrags- und freier Pfad)', () => {
    const local = invoice();
    const remote = invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>);
    const applied = applyFinalizedInvoiceToList([local], remote, null);
    expect(applied.ok && applied.action).toBe('status_raised');
    expect(applied.ok && applied.invoice.customerId).toBe('cust-1');

    hydrateInvoiceStore([{ invoice: local, vorgangId: null }]);
    const upsert = upsertFinalizedManualInvoice(remote);
    expect(upsert.ok && upsert.action).toBe('status_raised');
    expect(findInvoiceLocatorById('inv-1')!.invoice.customerId).toBe('cust-1');
  });

  it('T9: lokal vorhanden + remote fehlend → Wert bleibt', () => {
    const applied = applyFinalizedInvoiceToList(
      [invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>)],
      invoice(),
      null,
    );
    expect(applied.ok && applied.action).toBe('noop');
    expect(applied.ok && applied.invoice.customerId).toBe('cust-1');
  });

  it('T10: gleiche Kennung → kein Konflikt, noop', () => {
    const a = invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>);
    const applied = applyFinalizedInvoiceToList([a], { ...a }, null);
    expect(applied.ok && applied.action).toBe('noop');
  });

  it('T11: verschiedene Kennungen → expliziter Konflikt, nirgends still entschieden', () => {
    const local = invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>);
    const remote = invoice({ customerId: 'cust-2' } as Partial<VorgangInvoice>);

    const applied = applyFinalizedInvoiceToList([local], remote, null);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.reason).toBe('customer_relation_conflict');

    hydrateInvoiceStore([{ invoice: local, vorgangId: null }]);
    const upsert = upsertFinalizedManualInvoice(remote);
    expect(upsert.ok).toBe(false);
    if (!upsert.ok) expect(upsert.reason).toBe('customer_relation_conflict');
    expect(findInvoiceLocatorById('inv-1')!.invoice.customerId).toBe('cust-1');

    // Pull-Merge meldet den Konflikt benannt — nicht als Inhaltskonflikt.
    const merge = mergeCloudInvoicesIntoVorgaenge([], [mapped(remote)], { workspaceId: 'ws-1', reconcileIntents: false });
    expect(merge.conflicts.map((c) => c.reason)).toEqual(['customer_relation_conflict']);

    // Auch über den Vorgangspfad.
    const vorgang = createTestVorgang({ id: 'v-1' });
    vorgang.invoices = [local];
    const mergeV = mergeCloudInvoicesIntoVorgaenge([vorgang], [mapped(remote, 'v-1')], { workspaceId: 'ws-1', reconcileIntents: false });
    expect(mergeV.conflicts.map((c) => c.reason)).toEqual(['customer_relation_conflict']);
  });

  /* ---------------- Fingerprint ---------------- */

  it('T12: der Content-Fingerprint ist unabhängig von customerId', () => {
    const ohne = invoice();
    const mit = invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>);
    expect(immutableInvoiceFingerprint(ohne)).toBe(immutableInvoiceFingerprint(mit));

    const draftOhne = buildManualInvoiceDraft({ billing: MUELLER }, SETUP);
    const draftMit = { ...draftOhne, customerId: 'cust-1' };
    expect(buildInvoiceFinalizationContentFingerprint(draftOhne, SETUP)).toBe(
      buildInvoiceFinalizationContentFingerprint(draftMit, SETUP),
    );
  });

  it('T13: die separate Relationsprüfung erkennt den Kundenkonflikt trotz gleichem Fingerprint', () => {
    const a = invoice({ customerId: 'cust-1' } as Partial<VorgangInvoice>);
    const b = invoice({ customerId: 'cust-2' } as Partial<VorgangInvoice>);
    expect(immutableInvoiceFingerprint(a)).toBe(immutableInvoiceFingerprint(b));
    expect(resolveInvoiceCustomerRelation(a.customerId, b.customerId).ok).toBe(false);
  });

  /* ---------------- Kundenhistorie ---------------- */

  it('T16: die Kundenhistorie findet die freie Rechnung über customerId', () => {
    const customer = newCustomer();
    hydrateInvoiceStore([
      { invoice: invoice({ customerId: customer.id } as Partial<VorgangInvoice>), vorgangId: null },
    ]);
    const entry = getKundenOverview().find((k) => k.kind === 'customer' && k.key === customer.id);
    expect(entry?.openInvoiceCount).toBe(1);

    const workspace = getKundenWorkspace('customer', customer.id);
    expect(workspace?.openInvoices.map((i) => i.id)).toEqual(['inv-1']);
    expect(workspace?.openInvoices[0]!.vorgangId).toBeNull();
    expect(workspace?.openInvoices[0]!.route).toBe('/rechnungen/offen');
  });

  it('T17: gleicher Name, andere customerId → keine falsche Zuordnung', () => {
    const a = newCustomer();
    const b = newCustomer({ email: 'zweite@example.invalid' });
    hydrateInvoiceStore([{ invoice: invoice({ customerId: b.id } as Partial<VorgangInvoice>), vorgangId: null }]);
    const overview = getKundenOverview();
    expect(overview.find((k) => k.key === a.id)?.openInvoiceCount).toBe(0);
    expect(overview.find((k) => k.key === b.id)?.openInvoiceCount).toBe(1);
    expect(getKundenWorkspace('customer', a.id)?.openInvoices).toEqual([]);
  });

  it('T18: ohne customerId gibt es keine Namensheuristik', () => {
    const customer = newCustomer();
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    expect(getKundenOverview().find((k) => k.key === customer.id)?.openInvoiceCount).toBe(0);
    expect(getKundenWorkspace('customer', customer.id)?.openInvoices).toEqual([]);
    expect(resolveInvoiceCustomerId(invoice(), null)).toBeUndefined();
  });

  it('T19: eine Kundenumbenennung verändert Snapshot und Referenz nicht', () => {
    const customer = newCustomer();
    const inv = invoice({ customerId: customer.id } as Partial<VorgangInvoice>);
    hydrateInvoiceStore([{ invoice: inv, vorgangId: null }]);
    const fingerprintBefore = immutableInvoiceFingerprint(inv);

    const renamed = updateCustomer(customer.id, { name: 'Müller & Söhne Bau GmbH', city: 'Bochum' });
    expect(renamed.success).toBe(true);

    const after = findInvoiceLocatorById('inv-1')!.invoice;
    expect(after.customerSnapshot).toEqual(MUELLER);
    expect(after.customerId).toBe(customer.id);
    expect(immutableInvoiceFingerprint(after)).toBe(fingerprintBefore);
    expect(buildInvoicePrintModelFromInvoice(after).customer).toEqual(MUELLER);
    expect(getKundenWorkspace('customer', customer.id)?.openInvoices).toHaveLength(1);
  });

  it('T20: ein fehlender Kundenstammsatz zerstört die Rechnung nicht — Orphan statt Namenszuordnung', () => {
    newCustomer(); // gleicher Name im Stamm, aber andere Kennung
    const inv = invoice({ customerId: 'cust-geloescht' } as Partial<VorgangInvoice>);
    hydrateInvoiceStore([{ invoice: inv, vorgangId: null }]);

    expect(getCustomerById('cust-geloescht')).toBeUndefined();
    expect(() => buildInvoicePrintModelFromInvoice(inv)).not.toThrow();
    expect(archiveOutgoingInvoice(null, inv, SETUP.companyName).success).toBe(true);

    const orphan = getKundenOverview().find((k) => k.kind === 'orphan' && k.key === 'cust-geloescht');
    expect(orphan?.openInvoiceCount).toBe(1);
    expect(getKundenWorkspace('orphan', 'cust-geloescht')?.openInvoices).toHaveLength(1);
    // Der gleichnamige Bestandskunde bekommt sie nicht.
    const named = getKundenOverview().find((k) => k.kind === 'customer');
    expect(named?.openInvoiceCount).toBe(0);
  });

  it('T21: eine alte Vorgangsrechnung ohne invoice.customerId läuft über den Vorgang', () => {
    const customer = newCustomer();
    const vorgang = createTestVorgang({ id: 'v-1', customerId: customer.id });
    hydrateVorgangStore([vorgang]);
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: 'v-1' }]);
    expect(resolveInvoiceCustomerId(invoice(), vorgang)).toBe(customer.id);
    expect(getKundenOverview().find((k) => k.key === customer.id)?.openInvoiceCount).toBe(1);
    expect(getKundenWorkspace('customer', customer.id)?.openInvoices).toHaveLength(1);
  });

  it('T22: invoice.customerId + vorgang.customerId auf denselben Kunden → genau einmal gezählt', () => {
    const customer = newCustomer();
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', customerId: customer.id })]);
    hydrateInvoiceStore([
      { invoice: invoice({ customerId: customer.id } as Partial<VorgangInvoice>), vorgangId: 'v-1' },
    ]);
    expect(getKundenOverview().find((k) => k.key === customer.id)?.openInvoiceCount).toBe(1);
    expect(getKundenWorkspace('customer', customer.id)?.openInvoices).toHaveLength(1);
  });

  it('T22b: widersprechen beide, ist invoice.customerId für die Historie massgeblich', () => {
    const a = newCustomer();
    const b = newCustomer({ email: 'b@example.invalid' });
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', customerId: a.id })]);
    hydrateInvoiceStore([{ invoice: invoice({ customerId: b.id } as Partial<VorgangInvoice>), vorgangId: 'v-1' }]);
    expect(getKundenWorkspace('customer', b.id)?.openInvoices).toHaveLength(1);
    expect(getKundenWorkspace('customer', a.id)?.openInvoices).toEqual([]);
  });

  /* ---------------- Validierung ---------------- */

  it('T23: die Validatoren akzeptieren fehlend/gültig und lehnen Leerstring, Whitespace, Zahl, Objekt, null ab', () => {
    // Ein Freigabe-Request trägt den Zustand vor der Freigabe.
    const prepared = (overrides: Partial<VorgangInvoice> = {}) =>
      invoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined, ...overrides } as Partial<VorgangInvoice>);
    const ok = (inv: VorgangInvoice) => {
      const request = validatePreparedWorkspaceInvoiceFinalizeRequest(preparedRequest(inv));
      const payload = validateWorkspaceInvoiceCloudPayload(buildInvoicePayloadV1(inv));
      return request.ok && payload.ok;
    };

    expect(ok(prepared()), 'Basisrechnung abgewiesen').toBe(true);
    expect(ok(prepared({ customerId: 'cust-1' } as Partial<VorgangInvoice>))).toBe(true);
    for (const bad of ['', '  ', ' cust-1', 42, { id: 'x' }, ['x'], null]) {
      const inv = prepared({ customerId: bad } as unknown as Partial<VorgangInvoice>);
      const request = validatePreparedWorkspaceInvoiceFinalizeRequest(preparedRequest(inv));
      expect(request.ok, `Request akzeptierte customerId=${JSON.stringify(bad)}`).toBe(false);
      const payload = buildInvoicePayloadV1(inv);
      if (payload) {
        expect(validateWorkspaceInvoiceCloudPayload(payload).ok, `Payload akzeptierte ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });

  it('T24: Abschlag/Schluss ohne Vorgang bleiben unzulässig — auch mit Kundenreferenz', () => {
    const customer = newCustomer();
    for (const type of ['abschlag', 'schluss'] as const) {
      const draft = {
        ...buildManualInvoiceDraft({ customerId: customer.id, billing: billingFromCustomer(customer) }, SETUP),
        type,
      };
      const result = finalizeInvoiceDraft(null, draft, SETUP);
      expect(result.ok).toBe(false);
    }
  });

  it('T25: Druckmodell, PDF-Modell, Archivtext und Tags enthalten die Kennung nirgends', () => {
    const inv = invoice({ customerId: 'cust-sehr-eindeutig-9f3' } as Partial<VorgangInvoice>);
    hydrateInvoiceStore([{ invoice: inv, vorgangId: null }]);
    expect(JSON.stringify(buildInvoicePrintModelFromInvoice(inv))).not.toContain('cust-sehr-eindeutig-9f3');
    const archived = archiveOutgoingInvoice(null, inv, SETUP.companyName);
    expect(archived.success).toBe(true);
    if (!archived.success) return;
    expect(archived.document.recognizedText).not.toContain('cust-sehr-eindeutig-9f3');
    expect(archived.document.tags.join(' ')).not.toContain('cust-sehr-eindeutig-9f3');
    expect(archived.document.title).not.toContain('cust-sehr-eindeutig-9f3');
  });
});
