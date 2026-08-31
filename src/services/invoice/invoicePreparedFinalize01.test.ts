/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4B — vorbereiteter
 * Cloud-Request, exakt ausgeführt.
 *
 * Ausschließlich synthetische, neutrale Daten. Keine reale Firma, kein realer
 * Vorgang, keine echte Workspace-Kennung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceDraft, InvoiceDraftPosition, VorgangInvoice } from '../../types/models';
import {
  INVOICE_DRAFT_PREPARATION_FORMAT_VERSION,
  INVOICE_DRAFT_PREPARATION_KIND,
  type InvoiceDraftIdentity,
} from '../../types/invoiceDraftDurability';

import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as vorgangService from '../vorgangService';
import * as archiveService from '../invoiceArchiveService';
import * as invoiceServiceModule from '../invoiceService';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import * as storageScopeService from '../storage/storageScopeService';

const cloudState = {
  configured: true,
  session: null as unknown,
  sessionGate: null as null | Promise<void>,
  workspaceId: 'ws-b',
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcHandler: null as null | ((args: Record<string, unknown>) => unknown),
  rpcError: null as null | { message: string; code?: string },
};

const localState = {
  vorgang: { id: 'vg-b-1' } as unknown,
  upsert: null as null | ((invoice: VorgangInvoice) => unknown),
  upsertCalls: [] as VorgangInvoice[],
  archive: null as null | ((invoice: VorgangInvoice, companyName: string) => unknown),
  archiveCalls: [] as { invoice: VorgangInvoice; companyName: string }[],
};

function installEnvironment(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(() => cloudState.configured);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
    () =>
      ({
        auth: {
          getSession: async () => {
            if (cloudState.sessionGate) await cloudState.sessionGate;
            return { data: { session: cloudState.session }, error: null };
          },
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
          cloudState.rpcCalls.push({ name, args });
          if (cloudState.rpcError) return { data: null, error: cloudState.rpcError };
          return { data: cloudState.rpcHandler?.(args) ?? null, error: null };
        },
      }) as never,
  );
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockImplementation(
    () => ({ workspace: { id: cloudState.workspaceId } }) as never,
  );
  vi.spyOn(vorgangService, 'getVorgangById').mockImplementation(
    (id: string) =>
      ((localState.vorgang as { id?: string } | null)?.id === id
        ? localState.vorgang
        : undefined) as never,
  );
  vi.spyOn(vorgangService, 'upsertFinalizedInvoiceOnVorgang').mockImplementation(
    (_vorgangId: string, invoice: VorgangInvoice) => {
      localState.upsertCalls.push(invoice);
      return (localState.upsert?.(invoice) ?? { ok: true, invoice, action: 'inserted' }) as never;
    },
  );
  vi.spyOn(archiveService, 'archiveOutgoingInvoice').mockImplementation(
    (_vorgangId: string, invoice: VorgangInvoice, companyName: string) => {
      localState.archiveCalls.push({ invoice, companyName });
      return (localState.archive?.(invoice, companyName) ?? { success: true, invoice }) as never;
    },
  );
}

import * as syncMetaService from '../sync/syncMetaService';
import {
  executePreparedInvoiceFinalization,
  prepareInvoiceDraftFinalization,
} from './invoicePreparedFinalizeService';
import {
  buildInvoicePayloadV1,
  validateInvoiceApprovalContext,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
  PREPARED_FINALIZE_REQUEST_KIND,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  INVOICE_APPROVAL_CONTEXT_KIND,
  INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION,
  type PreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';
import {
  buildActualPreparedResponseProjection,
  buildExpectedPreparedResponseProjection,
  canonicalJsonStringify,
  isPlainJsonObject,
} from './invoicePreparedResponseProjection';
import {
  buildWorkspaceInvoiceFinalizePayload,
  rpcFinalizePreparedWorkspaceInvoice,
  WorkspaceInvoiceCloudError,
} from './workspaceInvoiceCloudService';
import {
  beginInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { setActiveStorageScope, resetStorageScopeForTests } from '../storage/storageScopeService';
import * as intentService from './invoiceFinalizeIntentService';

const WORKSPACE = 'ws-b';
const SCOPE = 'workspace:ws-b';
const VORGANG = 'vg-b-1';
const DRAFT_ID = 'draft-b-1';
const CLIENT_ID = 'inv-b-0001';
const PREPARED_AT = '2026-08-21T09:00:00.000Z';
const LONG_TEXT = `Hinweis ${'Beispieltext '.repeat(20)}Ende`;

function buildPosition(index: number): InvoiceDraftPosition {
  return {
    id: `pos-${index}`,
    orderPositionId: `op-${index}`,
    description: `Beispielposition ${index} — ${LONG_TEXT}`,
    plannedQuantity: 10 + index,
    billedQuantity: 0,
    openQuantity: 10,
    quantity: 2 + index,
    unit: 'Stück',
    unitLabel: 'Stück',
    unitPrice: 10 + index,
    billable: true,
  };
}

function buildDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    id: DRAFT_ID,
    vorgangId: VORGANG,
    vorgangTitle: 'Beispielvorgang',
    customer: 'Beispiel Kundschaft GmbH',
    baustelle: 'Musterweg 1',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'quantity_based',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [buildPosition(1), buildPosition(2)],
    issueDate: '2026-08-21',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-20',
    paymentDueDate: '2026-09-04',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerBilling: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: 'kontakt@beispiel.example',
      phone: '030 0000000',
    },
    companySnapshot: {
      companyName: 'Beispiel Betrieb GmbH',
      legalForm: 'GmbH',
      logoDataUrl: 'data:image/png;base64,AAAA',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Betriebsstadt',
      country: 'Deutschland',
      contactPerson: 'B. Beispiel',
      phone: '030 1111111',
      email: 'info@betrieb.example',
      website: '',
      taxNumber: '11/222/33333',
      vatId: 'DE000000000',
      bankName: 'Beispielbank',
      iban: 'DE00000000000000000000',
      bic: 'BEISPIELXXX',
      defaultPaymentDays: 14,
      defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
      defaultSkonto: '',
      invoiceFooterNotes: LONG_TEXT,
    } as InvoiceDraft['companySnapshot'],
    legalNotices: [LONG_TEXT],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: LONG_TEXT,
    closingText: LONG_TEXT,
    ...overrides,
  } as InvoiceDraft;
}

function buildSetup(overrides: Record<string, unknown> = {}) {
  return {
    companyName: 'Beispiel Betrieb GmbH',
    taxStatus: 'standard_19',
    ...overrides,
  } as never;
}

function identity(overrides: Partial<InvoiceDraftIdentity> = {}): InvoiceDraftIdentity {
  return {
    sourceScopeKey: SCOPE,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'abschlag',
    draftId: DRAFT_ID,
    ...overrides,
  };
}

function prepareInput(overrides: Record<string, unknown> = {}) {
  return {
    vorgangId: VORGANG,
    draft: buildDraft(),
    setup: buildSetup(),
    approvalOptions: {},
    overbillingAcknowledged: false,
    ...overrides,
  };
}

/**
 * Fachlich asymmetrisch: nicht abrechenbar, aber mit positiver Menge. Der
 * Entwurfs-Fingerprint trägt `billable: false`, der Rechnungs-Fingerprint
 * setzt `billable` fest auf `true` — die Vorbereitung muss das erkennen.
 */
function buildAsymmetricDraft(): InvoiceDraft {
  const positions = [buildPosition(1), buildPosition(2)];
  positions[0] = { ...positions[0]!, billable: false };
  return buildDraft({ positions });
}

/** Ein Entwurf mit echter Überbilligung: abrechenbar und über der Restmenge. */
function buildOverbilledDraft(): InvoiceDraft {
  const positions = [buildPosition(1), buildPosition(2)];
  positions[0] = { ...positions[0]!, quantity: 25, openQuantity: 10 };
  return buildDraft({ positions });
}

/** Spiegelt finalize_workspace_invoice: normalisieren, dann Serverfelder setzen. */
function serverEcho(
  sent: Record<string, unknown>,
  clientInvoiceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...sent };
  /*
   * 01P4E3B — exakt die zehn Schlüssel der **aktiven** SQL-Fassung von
   * `normalize_workspace_invoice_payload_for_idempotency` aus der
   * Amendment-Migration. Das Fixture kannte bisher nur acht und spiegelte den
   * Server damit unvollständig.
   */
  for (const key of [
    'number',
    'invoiceSequenceNumber',
    'invoice_sequence_number',
    'payments',
    'paymentStatus',
    'payment_status',
    'archiveDocumentId',
    'archive_document_id',
    'expectedAmendmentSequence',
    'expected_amendment_sequence',
  ]) {
    delete payload[key];
  }
  const issueDate = String(payload.issueDate ?? payload.date ?? '2026-08-21');
  return {
    ...payload,
    id: clientInvoiceId,
    number: '2026-0007',
    invoiceSequenceNumber: 7,
    type: payload.type,
    status: 'vorbereitet',
    date: issueDate,
    issueDate,
    ...overrides,
  };
}

/*
 * 01P4E1E — das Fixture trug bisher nur sechs Spalten. Das SQL gibt mit
 * `to_jsonb(v_existing)` die **vollständige** Tabellenzeile zurück; `payload`
 * ist dabei identisch mit `data.invoice`. Nur diese Fixture-Unwahrheit wird
 * korrigiert, keine Produktionserwartung gelockert.
 */
function fullServerRow(
  args: Record<string, unknown>,
  invoice: Record<string, unknown>,
): Record<string, unknown> {
  const issueDate = String(invoice.issueDate ?? invoice.date ?? '2026-08-21');
  return {
    id: 'cloud-row-1',
    workspace_id: args.p_workspace_id,
    vorgang_id: args.p_vorgang_id,
    client_invoice_id: args.p_client_invoice_id,
    invoice_number: invoice.number,
    invoice_year: Number(issueDate.slice(0, 4)),
    invoice_sequence_number: invoice.invoiceSequenceNumber,
    invoice_type: invoice.type,
    invoice_status: invoice.status,
    payload: invoice,
    row_version: 1,
    created_at: '2026-08-21T09:00:00.000Z',
    updated_at: '2026-08-21T09:00:00.000Z',
    updated_by: null,
  };
}

function installServer(overrides: Record<string, unknown> = {}, idempotentReplay = false) {
  cloudState.rpcHandler = (args) => {
    const sent = args.p_invoice as Record<string, unknown>;
    const invoice = serverEcho(sent, String(args.p_client_invoice_id), overrides);
    return {
      idempotent_replay: idempotentReplay,
      invoice,
      row: fullServerRow(args, invoice),
    };
  };
}

async function seedPrepared(): Promise<PreparedWorkspaceInvoiceFinalizeRequest> {
  const created = await createInvoiceDraftRecord({
    identity: identity(),
    draft: buildDraft(),
    now: '2026-08-21T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);

  const prepared = await prepareInvoiceDraftFinalization(prepareInput());
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) throw new Error('prepare fehlgeschlagen');

  const begun = await beginInvoiceDraftFinalization({
    identity: identity(),
    expectedRevision: 1,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request as never,
    approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
    now: PREPARED_AT,
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);
  return prepared.request;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  installEnvironment();
  cloudState.configured = true;
  cloudState.session = { user: { id: 'u-1' } };
  cloudState.sessionGate = null;
  cloudState.workspaceId = WORKSPACE;
  cloudState.rpcCalls = [];
  cloudState.rpcError = null;
  installServer();
  localState.vorgang = { id: VORGANG };
  localState.upsert = null;
  localState.upsertCalls = [];
  localState.archive = null;
  localState.archiveCalls = [];
  vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => CLIENT_ID);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetStorageScopeForTests();
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

describe('01P4B — vorbereiteter Cloud-Request', () => {
  it('B1: prepare ruft keinen RPC, keinen Intent und schreibt nichts', async () => {
    const intentRead = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
    const intentClear = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');
    const created = await createInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft(),
      now: '2026-08-21T08:00:00.000Z',
    });
    expect(created.ok).toBe(true);

    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);

    expect(cloudState.rpcCalls.length).toBe(0);
    expect(intentRead).not.toHaveBeenCalled();
    expect(intentClear).not.toHaveBeenCalled();
    expect(localState.upsertCalls.length).toBe(0);
    expect(localState.archiveCalls.length).toBe(0);

    // Der Entwurf bleibt unverändert active — prepare schreibt keine Vorbereitung.
    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.revision).toBe(1);
    }
  });

  it('B2: prepare erzeugt die Kennung intern', async () => {
    let calls = 0;
    vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => {
      calls += 1;
      return `${CLIENT_ID}-${calls}`;
    });

    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    expect(calls).toBe(1);
    expect(prepared.clientInvoiceId).toBe(`${CLIENT_ID}-1`);
    expect(prepared.request.clientInvoiceId).toBe(`${CLIENT_ID}-1`);
    expect(prepared.request.invoice.id).toBe(`${CLIENT_ID}-1`);
    // Keine öffentliche Kennungseingabe.
    expect(Object.keys(prepareInput())).not.toContain('clientInvoiceId');
  });

  it('B3: die Vorbereitung entsteht vollständig vor dem ersten await', async () => {
    let release: (() => void) | null = null;
    cloudState.sessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const draft = buildDraft();
    const setup = buildSetup();
    const pending = prepareInvoiceDraftFinalization({
      vorgangId: VORGANG,
      draft,
      setup,
      approvalOptions: {},
      overbillingAcknowledged: false,
    });

    // Mutation während der angehaltenen Auth-Prüfung.
    draft.introText = 'nachträglich verändert';
    draft.positions[0]!.unitPrice = 999999;
    draft.positions[0]!.quantity = 9999;
    (setup as unknown as { companyName: string }).companyName = 'Fremde Firma GmbH';

    release?.();
    const prepared = await pending;
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.request.invoice.introText).toBe(LONG_TEXT);
    expect(prepared.request.invoice.positions[0]?.unitPrice).toBe(11);
    expect(prepared.approvalContext.archiveCompanyName).toBe('Beispiel Betrieb GmbH');
    expect(prepared.approvalContext.overbillingEvidenceKeys).toEqual([]);
    expect(prepared.request.invoicePayload.introText).toBe(LONG_TEXT);
  });

  it('B4: die Regeln des Freigabekontexts werden vollständig erzwungen', async () => {
    // Reverse Charge ohne Bestätigung.
    const reverse = await prepareInvoiceDraftFinalization(
      prepareInput({
        draft: buildDraft({ taxStatus: 'reverse_charge_13b' }),
        setup: buildSetup({ taxStatus: 'reverse_charge_13b' }),
        approvalOptions: { reverseCharge13bConfirmed: false },
      }),
    );
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) {
      expect(['validation_failed', 'invalid_approval_context']).toContain(reverse.reason);
    }

    // Ohne Warnung darf nichts bestätigt sein.
    const spurious = await prepareInvoiceDraftFinalization(
      prepareInput({ overbillingAcknowledged: true }),
    );
    expect(spurious.ok).toBe(false);
    if (!spurious.ok) expect(spurious.reason).toBe('invalid_approval_context');

    // Leerer Firmenname für die Archivierung.
    const noCompany = await prepareInvoiceDraftFinalization(
      prepareInput({ setup: buildSetup({ companyName: '  ' }) }),
    );
    expect(noCompany.ok).toBe(false);
    if (!noCompany.ok) expect(noCompany.reason).toBe('invalid_approval_context');

    // Gültiger Fall mit echter, aus dem Entwurf abgeleiteter Überbilligung.
    const okCase = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildOverbilledDraft(), overbillingAcknowledged: true }),
    );
    expect(okCase.ok, JSON.stringify(okCase)).toBe(true);
    if (okCase.ok) {
      expect(okCase.approvalContext.kind).toBe(INVOICE_APPROVAL_CONTEXT_KIND);
      expect(okCase.approvalContext.formatVersion).toBe(INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION);
      expect(okCase.approvalContext.overbillingRequired).toBe(true);
      expect(okCase.approvalContext.overbillingEvidenceKeys).toEqual([
        'overbilling:pos-1:op-1:25:10',
      ]);
      expect('approvedAt' in okCase.approvalContext).toBe(false);
    }
  });

  it('B5: der Request enthält invoice, invoicePayload und die Antwortprojektion', async () => {
    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    const request = prepared.request;
    expect(request.kind).toBe(PREPARED_FINALIZE_REQUEST_KIND);
    expect(request.formatVersion).toBe(PREPARED_FINALIZE_REQUEST_FORMAT_VERSION);
    expect(Object.keys(request).sort()).toEqual(
      [
        'clientInvoiceId',
        'expectedResponseProjectionRawJson',
        'formatVersion',
        'invoice',
        'invoicePayload',
        'kind',
        'vorgangId',
        'workspaceId',
      ].sort(),
    );
    expect(request.invoicePayload).toEqual(buildWorkspaceInvoiceFinalizePayload(request.invoice));
    expect(request.expectedResponseProjectionRawJson).toBe(
      buildExpectedPreparedResponseProjection(request.invoicePayload, request.clientInvoiceId),
    );
    // Der eingefrorene Kandidat behält den Zahlungsstatus-freien Cloud-Payload.
    expect('payments' in request.invoicePayload).toBe(false);
    expect('paymentStatus' in request.invoicePayload).toBe(false);
    expect('archiveDocumentId' in request.invoicePayload).toBe(false);
  });

  it('B6: der Validator lehnt unbekannte und gefährliche Felder ab', async () => {
    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const base = JSON.parse(
      JSON.stringify(prepared.request),
    ) as unknown as Record<string, unknown>;

    expect(validatePreparedWorkspaceInvoiceFinalizeRequest(base).ok).toBe(true);

    const cases: [string, (value: Record<string, unknown>) => void][] = [
      ['unbekanntes Top-Level-Feld', (v) => void (v.extra = 1)],
      [
        'unbekanntes invoice-Feld',
        (v) => void ((v.invoice as Record<string, unknown>).extra = 1),
      ],
      [
        'unbekanntes payload-Feld',
        (v) => void ((v.invoicePayload as Record<string, unknown>).extra = 1),
      ],
      [
        'unbekanntes Positionsfeld',
        (v) => {
          const positions = (v.invoice as { positions: Record<string, unknown>[] }).positions;
          positions[0]!.extra = 1;
        },
      ],
      [
        'unbekanntes companySnapshot-Feld',
        (v) => {
          const invoice = v.invoice as { companySnapshot: Record<string, unknown> };
          invoice.companySnapshot.extra = 1;
        },
      ],
      [
        'unbekanntes customerSnapshot-Feld',
        (v) => {
          const invoice = v.invoice as { customerSnapshot: Record<string, unknown> };
          invoice.customerSnapshot.extra = 1;
        },
      ],
      ['fremde kind', (v) => void (v.kind = 'fremd')],
      // 01P4E3D — 2 ist jetzt die gültige Version; abgewiesen wird die alte 1.
      ['fremde formatVersion', (v) => void (v.formatVersion = 1)],
      [
        'abweichende Rechnungs-ID',
        (v) => void ((v.invoice as Record<string, unknown>).id = 'inv-fremd'),
      ],
      [
        'falscher Status',
        (v) => void ((v.invoice as Record<string, unknown>).status = 'entwurf'),
      ],
      [
        'snake_case-Zwilling',
        (v) => void ((v.invoicePayload as Record<string, unknown>).expected_amendment_sequence = 1),
      ],
      [
        'nicht endliche Zahl',
        (v) => void ((v.invoice as Record<string, unknown>).amount = Number.NaN),
      ],
    ];

    for (const [label, mutate] of cases) {
      const value = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(value);
      const result = validatePreparedWorkspaceInvoiceFinalizeRequest(value);
      expect(result.ok, label).toBe(false);
    }

    // Prototypenschlüssel auf jeder Ebene.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      const invoice = raw.invoice as Record<string, unknown>;
      Object.defineProperty(invoice, key, {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      expect(validatePreparedWorkspaceInvoiceFinalizeRequest(raw).ok, key).toBe(false);
    }
  });

  it('B7: vollständige Inhalte überstehen die Prüfung unverändert', async () => {
    const prepared = await prepareInvoiceDraftFinalization(
      prepareInput({
        draft: buildDraft({
          type: 'schluss',
          // Eine Schlussrechnung trägt keine Abschlagsnummer (usesAbschlagNumber).
          abschlagNumber: undefined,
          expectedAmendmentSequence: 3,
          previousAbschlagDeductions: [
            {
              invoiceId: 'inv-alt-1',
              invoiceNumber: '2026-0001',
              abschlagNumber: 1,
              date: '2026-07-01',
              subtotal: 100,
              amount: 119,
            },
          ],
        }),
      }),
    );
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(
      JSON.parse(JSON.stringify(prepared.request)),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.request.invoice.positions.length).toBe(2);
    expect(result.request.invoice.positions[0]?.description).toContain(LONG_TEXT);
    expect(result.request.invoice.positions[0]?.unitLabel).toBe('Stück');
    expect(result.request.invoice.legalNotices).toEqual([LONG_TEXT]);
    expect(result.request.invoice.previousAbschlagDeductions?.length).toBe(1);
    expect(result.request.invoice.introText).toBe(LONG_TEXT);
    expect(result.request.invoice.closingText).toBe(LONG_TEXT);
    expect(result.request.invoice.companySnapshot?.invoiceFooterNotes).toBe(LONG_TEXT);
    expect(result.request.invoice.expectedAmendmentSequence).toBe(3);
    expect(result.request.invoicePayload.expectedAmendmentSequence).toBe(3);
  });

  it('B8: invoicePayload entspricht exakt dem Version-1-Vertrag', async () => {
    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const v1 = buildInvoicePayloadV1(prepared.request.invoice);
    expect(v1).not.toBeNull();
    expect(prepared.request.invoicePayload).toEqual(v1);
    // Der Logo-Datenstrom verlässt das Gerät nicht.
    expect(prepared.request.invoice.companySnapshot?.logoDataUrl).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(
      (prepared.request.invoicePayload.companySnapshot as Record<string, unknown>).logoDataUrl,
    ).toBeUndefined();

    // Eine Abweichung zwischen invoice und Payload wird erkannt.
    const broken = JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>;
    (broken.invoicePayload as Record<string, unknown>).introText = 'abweichend';
    expect(validatePreparedWorkspaceInvoiceFinalizeRequest(broken).ok).toBe(false);
  });

  it('B9: die vorbereitete RPC-Funktion sendet den Payload unverändert', async () => {
    const payload = { id: CLIENT_ID, type: 'abschlag', positions: [], marker: 'unverändert' };
    installServer();

    const result = await rpcFinalizePreparedWorkspaceInvoice({
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      clientInvoiceId: CLIENT_ID,
      invoicePayload: payload,
    });

    expect(cloudState.rpcCalls.length).toBe(1);
    expect(cloudState.rpcCalls[0]?.name).toBe('finalize_workspace_invoice');
    expect(cloudState.rpcCalls[0]?.args.p_invoice).toEqual(payload);
    expect((cloudState.rpcCalls[0]?.args.p_invoice as Record<string, unknown>).marker).toBe(
      'unverändert',
    );
    expect(result.rawInvoicePayload.id).toBe(CLIENT_ID);
    expect(result.rowVersion).toBe(1);
    expect(result.cloudInvoiceId).toBe('cloud-row-1');
    // Die Eingabe wurde nicht mutiert.
    expect(payload).toEqual({
      id: CLIENT_ID,
      type: 'abschlag',
      positions: [],
      marker: 'unverändert',
    });
  });

  it('B10: die vorbereitete RPC-Funktion prüft Rohantwort und Row-Identität', async () => {
    const payload = { id: CLIENT_ID, type: 'abschlag', positions: [] };
    const call = () =>
      rpcFinalizePreparedWorkspaceInvoice({
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId: CLIENT_ID,
        invoicePayload: payload,
      });

    const cases: [string, () => void][] = [
      ['fehlende invoice', () => void (cloudState.rpcHandler = () => ({ row: { id: 'x' } }))],
      [
        'fehlende row',
        () => void (cloudState.rpcHandler = () => ({ invoice: { id: CLIENT_ID } })),
      ],
      [
        'fremder Workspace in row',
        () =>
          void (cloudState.rpcHandler = (args) => ({
            invoice: { id: CLIENT_ID },
            row: {
              id: 'cloud-row-1',
              workspace_id: 'ws-fremd',
              vorgang_id: args.p_vorgang_id,
              client_invoice_id: args.p_client_invoice_id,
              row_version: 1,
            },
          })),
      ],
      [
        'abweichende client_invoice_id',
        () =>
          void (cloudState.rpcHandler = (args) => ({
            invoice: { id: CLIENT_ID },
            row: {
              id: 'cloud-row-1',
              workspace_id: args.p_workspace_id,
              vorgang_id: args.p_vorgang_id,
              client_invoice_id: 'inv-fremd',
              row_version: 1,
            },
          })),
      ],
      [
        'row.payload weicht ab',
        () =>
          void (cloudState.rpcHandler = (args) => ({
            invoice: { id: CLIENT_ID, marker: 'a' },
            row: {
              id: 'cloud-row-1',
              workspace_id: args.p_workspace_id,
              vorgang_id: args.p_vorgang_id,
              client_invoice_id: args.p_client_invoice_id,
              payload: { id: CLIENT_ID, marker: 'b' },
              row_version: 1,
            },
          })),
      ],
      [
        'row_version ungültig',
        () =>
          void (cloudState.rpcHandler = (args) => ({
            invoice: { id: CLIENT_ID },
            row: {
              id: 'cloud-row-1',
              workspace_id: args.p_workspace_id,
              vorgang_id: args.p_vorgang_id,
              client_invoice_id: args.p_client_invoice_id,
              row_version: 0,
            },
          })),
      ],
    ];

    for (const [label, install] of cases) {
      install();
      await expect(call(), label).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }
  });

  /*
   * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1E — eine strukturell
   * ungültige Serverantwort erzeugt im Prepared-Dienst kein Teilergebnis und
   * keinen lokalen Persistenzschritt.
   */
  it('01P4E1E E8: eine ungültige Hülle erzeugt kein Teilergebnis und keine Persistenz', async () => {
    const brokenEnvelopes: Array<[string, (args: Record<string, unknown>) => unknown]> = [
      [
        'idempotent_replay als Zahl',
        (args) => {
          const invoice = serverEcho(
            args.p_invoice as Record<string, unknown>,
            String(args.p_client_invoice_id),
          );
          return { idempotent_replay: 1, invoice, row: fullServerRow(args, invoice) };
        },
      ],
      [
        'row.row_version als String',
        (args) => {
          const invoice = serverEcho(
            args.p_invoice as Record<string, unknown>,
            String(args.p_client_invoice_id),
          );
          return {
            idempotent_replay: false,
            invoice,
            row: { ...fullServerRow(args, invoice), row_version: '2' },
          };
        },
      ],
      [
        'row.id mit Rand-Whitespace',
        (args) => {
          const invoice = serverEcho(
            args.p_invoice as Record<string, unknown>,
            String(args.p_client_invoice_id),
          );
          return {
            idempotent_replay: false,
            invoice,
            row: { ...fullServerRow(args, invoice), id: ' cloud-row-1 ' },
          };
        },
      ],
      [
        'row.payload fehlt',
        (args) => {
          const invoice = serverEcho(
            args.p_invoice as Record<string, unknown>,
            String(args.p_client_invoice_id),
          );
          const row = fullServerRow(args, invoice);
          delete (row as Record<string, unknown>).payload;
          return { idempotent_replay: false, invoice, row };
        },
      ],
      [
        'unvollständige Zeile',
        (args) => {
          const invoice = serverEcho(
            args.p_invoice as Record<string, unknown>,
            String(args.p_client_invoice_id),
          );
          const row = fullServerRow(args, invoice);
          delete (row as Record<string, unknown>).invoice_year;
          return { idempotent_replay: false, invoice, row };
        },
      ],
    ];

    for (const [label, handler] of brokenEnvelopes) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      localState.upsertCalls = [];
      localState.archiveCalls = [];
      cloudState.rpcCalls = [];
      await seedPrepared();
      cloudState.rpcHandler = handler;

      const result = await executePreparedInvoiceFinalization({
        identity: identity(),
        expectedRevision: 2,
      });

      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        // Genau ein RPC — kein blinder Wiederholungsversuch.
        expect(cloudState.rpcCalls.length, label).toBe(1);
      }
      // Kein lokaler Persistenzschritt, keine Archivierung.
      expect(localState.upsertCalls, label).toEqual([]);
      expect(localState.archiveCalls, label).toEqual([]);
      // Kein Rohpayload und keine Cloud-Kennung im Ergebnis.
      expect(JSON.stringify(result), label).not.toContain('rawInvoicePayload');
      expect(JSON.stringify(result), label).not.toContain('cloud-row-1');
    }
  });

  it('B11: execute akzeptiert nur Identität und Revision', async () => {
    const request = await seedPrepared();

    const result = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.clientInvoiceId).toBe(CLIENT_ID);
    expect(result.cloudState).toBe('confirmed');
    expect(cloudState.rpcCalls.length).toBe(1);
    expect(cloudState.rpcCalls[0]?.args.p_client_invoice_id).toBe(CLIENT_ID);
    expect(cloudState.rpcCalls[0]?.args.p_invoice).toEqual(request.invoicePayload);
  });

  it('B12: Fingerprint- oder Requestabweichung blockiert vor dem RPC', async () => {
    await seedPrepared();

    const wrongRevision = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 5,
    });
    expect(wrongRevision.ok).toBe(false);
    if (!wrongRevision.ok) {
      expect(wrongRevision.reason).toBe('conflict');
      expect(wrongRevision.cloudState).toBe('not_committed');
    }

    const foreignIdentity = await executePreparedInvoiceFinalization({
      identity: identity({ draftId: 'draft-fremd' }),
      expectedRevision: 2,
    });
    expect(foreignIdentity.ok).toBe(false);
    if (!foreignIdentity.ok) {
      expect(['identity_mismatch', 'invalid_identity', 'not_found']).toContain(
        foreignIdentity.reason,
      );
      expect(foreignIdentity.cloudState).toBe('not_committed');
    }

    expect(cloudState.rpcCalls.length).toBe(0);
  });

  it('B13: ein vor execute geänderter Workspace oder Scope blockiert', async () => {
    await seedPrepared();
    cloudState.workspaceId = 'ws-fremd';

    const changed = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.reason).toBe('workspace_changed');
      expect(changed.cloudState).toBe('not_committed');
    }
    expect(cloudState.rpcCalls.length).toBe(0);

    cloudState.workspaceId = WORKSPACE;
    setActiveStorageScope({ type: 'guest' });
    const scope = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(scope.ok).toBe(false);
    if (!scope.ok) {
      expect(scope.reason).toBe('scope_mismatch');
      expect(scope.cloudState).toBe('not_committed');
    }
    expect(cloudState.rpcCalls.length).toBe(0);
  });

  it('B14: die Projektion erlaubt ausschließlich Nummer und Sequenz', async () => {
    await seedPrepared();
    installServer({ number: '2026-0099', invoiceSequenceNumber: 99 });

    const result = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.invoice.number).toBe('2026-0099');
      expect(result.invoice.invoiceSequenceNumber).toBe(99);
    }

    // Kanonische Darstellung ist schlüsselstabil.
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe(canonicalJsonStringify({ a: 2, b: 1 }));
    expect(canonicalJsonStringify({ a: undefined })).toBeNull();
    expect(canonicalJsonStringify({ a: Number.POSITIVE_INFINITY })).toBeNull();
    expect(canonicalJsonStringify({ a: null })).not.toBe(canonicalJsonStringify({}));
  });

  it('B15: inhaltliche Abweichungen der Antwort liefern cloud_response_mismatch', async () => {
    const overrides: [string, Record<string, unknown>][] = [
      ['companySnapshot', { companySnapshot: { companyName: 'Fremde Firma GmbH' } }],
      ['legalNotices', { legalNotices: ['fremd'] }],
      ['paymentTermsText', { paymentTermsText: 'fremd' }],
      ['positions', { positions: [{ id: 'x', description: 'fremd' }] }],
      ['issueDate', { issueDate: '2026-01-01' }],
      ['date', { date: '2026-01-01' }],
      ['type', { type: 'rechnung' }],
      /*
       * 01P4E3B — `expectedAmendmentSequence` steht hier nicht mehr: es ist
       * kein Rechnungsinhalt, sondern ein RPC-Metafeld, das die aktive SQL-
       * Normalisierung entfernt und das deshalb in **keiner** Antwortprojektion
       * erscheint. Der Fall prüfte zuvor nur die fehlende Parität. Sein
       * Schutzzweck liegt unverändert bei Fingerprint, Request-Validator und
       * serverseitigem Amendment-Guard und wird in 01P4E3B P4 belegt.
       */
      ['status', { status: 'entwurf' }],
    ];

    for (const [label, override] of overrides) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      cloudState.rpcCalls = [];
      localState.upsertCalls = [];
      await seedPrepared();
      installServer(override);

      const result = await executePreparedInvoiceFinalization({
        identity: identity(),
        expectedRevision: 2,
      });
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.reason, label).toBe('cloud_response_mismatch');
        expect(result.cloudState, label).toBe('confirmed');
      }
      expect(localState.upsertCalls.length, label).toBe(0);

      const record = await loadInvoiceDraftRecordByLocator({
        sourceScopeKey: SCOPE,
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        invoiceType: 'abschlag',
      });
      expect(record.ok, label).toBe(true);
      if (record.ok) expect(record.record.status, label).toBe('finalizing');
    }

    /*
     * 01P4E1E — abweichende Kennung, leere Rechnungsnummer und ungültige
     * Sequenz sind keine inhaltlichen, sondern **strukturelle** Abweichungen
     * der Antwortzeile. Sie werden seither eine Schicht früher abgewiesen —
     * schon der Spaltenvertrag der Zeile lehnt sie ab. Der Ausgang bleibt
     * gleich sicher: blockiert, keine Persistenz, Datensatz unverändert
     * `finalizing`, Wiederaufnahme über Reload statt blindem Wiederholen.
     */
    const structural: [string, Record<string, unknown>][] = [
      ['id', { id: 'inv-fremd' }],
      ['leere Nummer', { number: '' }],
      ['Sequenz ungültig', { invoiceSequenceNumber: 0 }],
    ];

    for (const [label, override] of structural) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      cloudState.rpcCalls = [];
      localState.upsertCalls = [];
      await seedPrepared();
      installServer(override);

      const result = await executePreparedInvoiceFinalization({
        identity: identity(),
        expectedRevision: 2,
      });
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe('rpc_failed');
      expect(localState.upsertCalls.length, label).toBe(0);

      const record = await loadInvoiceDraftRecordByLocator({
        sourceScopeKey: SCOPE,
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        invoiceType: 'abschlag',
      });
      expect(record.ok, label).toBe(true);
      if (record.ok) expect(record.record.status, label).toBe('finalizing');
    }
  });

  it('B16: die lokale Rechnung entsteht aus dem vorbereiteten Kandidaten', async () => {
    const request = await seedPrepared();
    const result = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const saved = localState.upsertCalls[0]!;
    expect(saved.id).toBe(CLIENT_ID);
    expect(saved.number).toBe('2026-0007');
    expect(saved.invoiceSequenceNumber).toBe(7);
    expect(saved.status).toBe('vorbereitet');
    expect(saved.paymentStatus).toBe('offen');
    expect(saved.payments).toEqual([]);
    // Alles Übrige stammt aus dem vorbereiteten Kandidaten — nichts geht verloren.
    expect(saved.companySnapshot).toEqual(request.invoice.companySnapshot);
    expect(saved.customerSnapshot).toEqual(request.invoice.customerSnapshot);
    expect(saved.legalNotices).toEqual(request.invoice.legalNotices);
    expect(saved.positions).toEqual(request.invoice.positions);
    expect(saved.positions[0]?.unitLabel).toBe('Stück');
    expect(saved.paymentTermsText).toBe(request.invoice.paymentTermsText);
    expect(saved.introText).toBe(LONG_TEXT);
    expect(saved.closingText).toBe(LONG_TEXT);
    expect(localState.archiveCalls[0]?.companyName).toBe('Beispiel Betrieb GmbH');
  });

  it('B17: zwei Ausführungen verwenden dieselbe clientInvoiceId', async () => {
    await seedPrepared();
    const first = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    installServer({}, true);
    const second = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (second.ok) expect(second.idempotentReplay).toBe(true);

    expect(cloudState.rpcCalls.length).toBe(2);
    expect(cloudState.rpcCalls[0]?.args.p_client_invoice_id).toBe(CLIENT_ID);
    expect(cloudState.rpcCalls[1]?.args.p_client_invoice_id).toBe(CLIENT_ID);
  });

  it('B18: cloudState wird für jeden Ausgang korrekt gesetzt', async () => {
    // not_committed — Cloud nicht konfiguriert.
    await seedPrepared();
    cloudState.configured = false;
    const offline = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(offline.ok).toBe(false);
    if (!offline.ok) {
      expect(offline.reason).toBe('offline_or_unconfigured');
      expect(offline.cloudState).toBe('not_committed');
    }
    cloudState.configured = true;

    // not_committed — keine Anmeldung.
    cloudState.session = null;
    const auth = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.reason).toBe('auth_missing');
      expect(auth.cloudState).toBe('not_committed');
    }
    cloudState.session = { user: { id: 'u-1' } };

    // unknown — Netzwerkfehler.
    cloudState.rpcError = { message: 'Failed to fetch' };
    const network = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(network.ok).toBe(false);
    if (!network.ok) {
      expect(network.reason).toBe('offline_or_unconfigured');
      expect(network.cloudState).toBe('unknown');
    }

    // conflict — Idempotenzkonflikt.
    cloudState.rpcError = { message: 'Idempotenzkonflikt: abweichender Rechnungsinhalt' };
    const conflict = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('idempotency_conflict');
      expect(conflict.cloudState).toBe('conflict');
    }

    // not_committed — Amendment-Zustand veraltet (serverseitiges Rollback).
    cloudState.rpcError = { message: 'invoice_amendment_state_stale' };
    const stale = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('amendment_state_stale');
      expect(stale.cloudState).toBe('not_committed');
    }

    // confirmed — Erfolg.
    cloudState.rpcError = null;
    installServer();
    const success = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(success.ok, JSON.stringify(success)).toBe(true);
    if (success.ok) expect(success.cloudState).toBe('confirmed');
  });

  it('B19: lokale Fehler und Archivwarnungen bleiben confirmed', async () => {
    await seedPrepared();
    localState.upsert = () => ({ ok: false, reason: 'local_persist_failed' });
    const persist = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(persist.ok).toBe(false);
    if (!persist.ok) {
      expect(persist.reason).toBe('local_persist_failed');
      expect(persist.cloudState).toBe('confirmed');
    }

    localState.upsert = () => ({ ok: false, reason: 'id_content_conflict' });
    const conflict = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('local_conflict');
      expect(conflict.cloudState).toBe('confirmed');
    }

    localState.upsert = null;
    localState.archive = () => ({ success: false, reason: 'archive_failed' });
    const archive = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(archive.ok, JSON.stringify(archive)).toBe(true);
    if (archive.ok) {
      expect(archive.archiveWarning).toBe(true);
      expect(archive.cloudState).toBe('confirmed');
    }
  });

  it('B20: der neue Pfad ist intent-frei und rejectet nie ungeprüft', async () => {
    const read = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
    const clear = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');
    const seed = vi.spyOn(intentService, 'getInvoiceFinalizeIntent');

    await seedPrepared();
    const ok = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(ok.ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();

    // Ein werfender Supabase-Aufruf wird typisiert abgefangen.
    cloudState.rpcHandler = () => {
      throw new Error('simulierter Aufrufsfehler');
    };
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await seedPrepared();
    const thrown = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(['rpc_failed', 'offline_or_unconfigured']).toContain(thrown.reason);
      expect(['unknown', 'not_committed']).toContain(thrown.cloudState);
    }

    // Ein werfender Vorgangszugriff in prepare bleibt typisiert.
    localState.vorgang = null;
    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.reason).toBe('vorgang_missing');

    // Die Projektionsbausteine bleiben rein.
    expect(buildActualPreparedResponseProjection({ id: 'x', number: 'y' })).toBe(
      canonicalJsonStringify({ id: 'x' }),
    );
    expect(validateInvoiceApprovalContext(null, { taxStatus: 'standard_19' }).ok).toBe(false);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4B1 — gehärtete Grenzen.
 * ========================================================================== */

/** Legt einen finalizing-Datensatz mit frei wählbarem Request und Fingerprint an. */
async function seedCustom(options: {
  mutateRequest?: (request: Record<string, unknown>) => void;
  contentFingerprint?: string;
}): Promise<void> {
  const created = await createInvoiceDraftRecord({
    identity: identity(),
    draft: buildDraft(),
    now: '2026-08-21T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);

  const prepared = await prepareInvoiceDraftFinalization(prepareInput());
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) throw new Error('prepare fehlgeschlagen');

  const request = JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>;
  options.mutateRequest?.(request);

  const begun = await beginInvoiceDraftFinalization({
    identity: identity(),
    expectedRevision: 1,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: options.contentFingerprint ?? prepared.contentFingerprint,
    request: request as never,
    approvalContext: JSON.parse(JSON.stringify(prepared.approvalContext)) as Record<
      string,
      unknown
    >,
    now: PREPARED_AT,
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);
}

describe('01P4B1 — gehärtete Prepare/Execute-Grenzen', () => {
  it('C1: das Produktionsmodul führt keine global veränderbare ID-Abhängigkeit', async () => {
    const serviceModule = (await import('./invoicePreparedFinalizeService')) as Record<
      string,
      unknown
    >;
    expect('preparedFinalizeDependencies' in serviceModule).toBe(false);

    // Eine gezielt gemockte Kennung wirkt nur, solange der Mock steht.
    vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => 'inv-synthetisch-1');
    const mocked = await prepareInvoiceDraftFinalization(prepareInput());
    expect(mocked.ok, JSON.stringify(mocked)).toBe(true);
    if (mocked.ok) expect(mocked.clientInvoiceId).toBe('inv-synthetisch-1');

    vi.restoreAllMocks();
    installEnvironment();
    const real = await prepareInvoiceDraftFinalization(prepareInput());
    expect(real.ok, JSON.stringify(real)).toBe(true);
    if (real.ok) {
      expect(real.clientInvoiceId.startsWith('inv-')).toBe(true);
      expect(real.clientInvoiceId).not.toBe('inv-synthetisch-1');
      expect(real.clientInvoiceId.length).toBeGreaterThan('inv-'.length);
    }
  });

  it('C2: Überbilligung wird ausschließlich aus dem Entwurf abgeleitet', async () => {
    // Öffentliche Eingabe kennt weder required noch Evidence.
    expect(Object.keys(prepareInput())).toEqual([
      'vorgangId',
      'draft',
      'setup',
      'approvalOptions',
      'overbillingAcknowledged',
    ]);

    const cleanUnacknowledged = await prepareInvoiceDraftFinalization(prepareInput());
    expect(cleanUnacknowledged.ok, JSON.stringify(cleanUnacknowledged)).toBe(true);
    if (cleanUnacknowledged.ok) {
      expect(cleanUnacknowledged.approvalContext.overbillingRequired).toBe(false);
      expect(cleanUnacknowledged.approvalContext.overbillingEvidenceKeys).toEqual([]);
    }

    const cleanAcknowledged = await prepareInvoiceDraftFinalization(
      prepareInput({ overbillingAcknowledged: true }),
    );
    expect(cleanAcknowledged.ok).toBe(false);
    if (!cleanAcknowledged.ok) {
      expect(cleanAcknowledged.reason).toBe('invalid_approval_context');
    }

    const overbilledUnacknowledged = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildOverbilledDraft(), overbillingAcknowledged: false }),
    );
    expect(overbilledUnacknowledged.ok).toBe(false);
    if (!overbilledUnacknowledged.ok) {
      expect(overbilledUnacknowledged.reason).toBe('invalid_approval_context');
    }

    const overbilledAcknowledged = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildOverbilledDraft(), overbillingAcknowledged: true }),
    );
    expect(overbilledAcknowledged.ok, JSON.stringify(overbilledAcknowledged)).toBe(true);
    if (!overbilledAcknowledged.ok) return;

    const context = overbilledAcknowledged.approvalContext;
    expect(context.overbillingRequired).toBe(true);
    expect(context.overbillingAcknowledged).toBe(true);
    // Genau die tatsächlich überbilligte Position, stabil und ohne UI-Text.
    expect(context.overbillingEvidenceKeys).toEqual(['overbilling:pos-1:op-1:25:10']);
    for (const key of context.overbillingEvidenceKeys) {
      expect(key).not.toContain('eingegeben');
      expect(key).not.toContain('offen.');
    }
  });

  it('C3: Reverse Charge bleibt an den eingefrorenen Kandidaten gebunden', async () => {
    const blocked = await prepareInvoiceDraftFinalization(
      prepareInput({
        draft: buildDraft({ taxStatus: 'reverse_charge_13b' }),
        approvalOptions: { reverseCharge13bConfirmed: false },
      }),
    );
    expect(blocked.ok).toBe(false);

    const allowed = await prepareInvoiceDraftFinalization(
      prepareInput({
        draft: buildDraft({ taxStatus: 'reverse_charge_13b' }),
        approvalOptions: { reverseCharge13bConfirmed: true },
      }),
    );
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    if (allowed.ok) {
      // Die Bindung erfolgt gegen den Kandidaten, nicht gegen den Eingabewert.
      expect(allowed.request.invoice.taxStatus).toBe('reverse_charge_13b');
      expect(allowed.approvalContext.reverseCharge13bConfirmed).toBe(true);
    }
  });

  it('C4: OrderUnit wird exakt geprüft und niemals normalisiert', async () => {
    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const base = JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>;

    const setUnit = (value: unknown) => {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      const invoice = copy.invoice as { positions: Record<string, unknown>[] };
      const payload = copy.invoicePayload as { positions: Record<string, unknown>[] };
      invoice.positions[0]!.unit = value;
      payload.positions[0]!.unit = value;
      return copy;
    };

    for (const unit of ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal']) {
      const result = validatePreparedWorkspaceInvoiceFinalizeRequest(setUnit(unit));
      expect(result.ok, unit).toBe(true);
      if (result.ok) expect(result.request.invoice.positions[0]?.unit, unit).toBe(unit);
    }

    for (const unit of ['stk', 'kg', '', 'Fantasie', 'stück', 'STÜCK']) {
      const result = validatePreparedWorkspaceInvoiceFinalizeRequest(setUnit(unit));
      expect(result.ok, JSON.stringify(unit)).toBe(false);
    }
  });

  it('C5: echter Fingerprint- und Requestfehler blockieren vor dem RPC', async () => {
    // (a) Der Kern speichert den abweichenden Geschäfts-Fingerprint bewusst;
    // execute muss ihn erkennen.
    await seedCustom({ contentFingerprint: 'fp-absichtlich-falsch' });
    const fingerprint = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(fingerprint.ok, JSON.stringify(fingerprint)).toBe(false);
    if (!fingerprint.ok) {
      expect(fingerprint.reason).toBe('fingerprint_mismatch');
      expect(fingerprint.cloudState).toBe('not_committed');
    }
    expect(cloudState.rpcCalls.length).toBe(0);

    // (b) Kernidentität gültig, Request nach Version 1 ungültig.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    cloudState.rpcCalls = [];
    await seedCustom({
      mutateRequest: (request) => {
        (request.invoice as Record<string, unknown>).unbekannt = 'feld';
      },
    });
    const invalid = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.reason).toBe('request_invalid');
      expect(invalid.cloudState).toBe('not_committed');
    }
    expect(cloudState.rpcCalls.length).toBe(0);

    // (c) Fachlich abweichender Payload bei gültiger Kernidentität.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    cloudState.rpcCalls = [];
    await seedCustom({
      mutateRequest: (request) => {
        (request.invoicePayload as Record<string, unknown>).paymentTermsText = 'abweichend';
      },
    });
    const drifted = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.reason).toBe('request_invalid');
    expect(cloudState.rpcCalls.length).toBe(0);
  });

  it('C6: Workspace- oder Scope-Wechsel während der Auth-Prüfung blockiert', async () => {
    // (a) Workspace wechselt im await-Fenster.
    await seedPrepared();
    let releaseWorkspace: (() => void) | null = null;
    cloudState.sessionGate = new Promise<void>((resolve) => {
      releaseWorkspace = resolve;
    });
    const workspaceRun = executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    cloudState.workspaceId = 'ws-waehrenddessen';
    releaseWorkspace?.();
    const workspaceResult = await workspaceRun;
    expect(workspaceResult.ok).toBe(false);
    if (!workspaceResult.ok) {
      expect(workspaceResult.reason).toBe('workspace_changed');
      expect(workspaceResult.cloudState).toBe('not_committed');
    }
    expect(cloudState.rpcCalls.length).toBe(0);

    // (b) Scope wechselt im await-Fenster.
    cloudState.workspaceId = WORKSPACE;
    cloudState.rpcCalls = [];
    let releaseScope: (() => void) | null = null;
    cloudState.sessionGate = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    const scopeRun = executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    setActiveStorageScope({ type: 'user', userId: 'u-fremd' });
    releaseScope?.();
    const scopeResult = await scopeRun;
    expect(scopeResult.ok).toBe(false);
    if (!scopeResult.ok) {
      expect(scopeResult.reason).toBe('scope_mismatch');
      expect(scopeResult.cloudState).toBe('not_committed');
    }
    expect(cloudState.rpcCalls.length).toBe(0);
  });

  it('C7: keine öffentliche Operation rejectet ungeprüft', async () => {
    const boom = () => {
      throw new Error('simulierter Fehler');
    };

    // (a) prepare: ID-Erzeugung wirft.
    vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(boom);
    const idFailure = await prepareInvoiceDraftFinalization(prepareInput());
    expect(idFailure.ok).toBe(false);
    if (!idFailure.ok) expect(idFailure.reason).toBe('invalid_candidate');
    vi.restoreAllMocks();
    installEnvironment();

    // (b) prepare: Fingerprintbildung wirft.
    vi.spyOn(invoiceServiceModule, 'buildInvoiceFinalizationContentFingerprint').mockImplementation(
      boom,
    );
    const fingerprintFailure = await prepareInvoiceDraftFinalization(prepareInput());
    expect(fingerprintFailure.ok).toBe(false);
    if (!fingerprintFailure.ok) expect(fingerprintFailure.reason).toBe('invalid_candidate');
    vi.restoreAllMocks();
    installEnvironment();

    // (c) prepare: Workspace-Snapshot wirft.
    vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockImplementation(boom);
    const snapshotFailure = await prepareInvoiceDraftFinalization(prepareInput());
    expect(snapshotFailure.ok).toBe(false);
    if (!snapshotFailure.ok) expect(snapshotFailure.reason).toBe('workspace_missing');
    vi.restoreAllMocks();
    installEnvironment();

    // (d) prepare: Scope-Auflösung wirft.
    vi.spyOn(storageScopeService, 'getActiveStorageScope').mockImplementation(boom);
    const scopeFailure = await prepareInvoiceDraftFinalization(prepareInput());
    expect(scopeFailure.ok).toBe(false);
    if (!scopeFailure.ok) expect(scopeFailure.reason).toBe('scope_mismatch');
    vi.restoreAllMocks();
    installEnvironment();

    // (e) prepare: isSupabaseConfigured wirft.
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(boom);
    const configFailure = await prepareInvoiceDraftFinalization(prepareInput());
    expect(configFailure.ok).toBe(false);
    if (!configFailure.ok) expect(configFailure.reason).toBe('preparation_failed');
    vi.restoreAllMocks();
    installEnvironment();

    // (f) prepare: getSession wirft.
    cloudState.session = { user: { id: 'u-1' } };
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
      () => ({ auth: { getSession: boom } }) as never,
    );
    const authFailure = await prepareInvoiceDraftFinalization(prepareInput());
    expect(authFailure.ok).toBe(false);
    if (!authFailure.ok) expect(authFailure.reason).toBe('auth_missing');
    vi.restoreAllMocks();
    installEnvironment();

    // (g) execute: isSupabaseConfigured wirft — not_committed.
    await seedPrepared();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(boom);
    const executeConfig = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(executeConfig.ok).toBe(false);
    if (!executeConfig.ok) {
      expect(executeConfig.reason).toBe('unexpected_error');
      expect(executeConfig.cloudState).toBe('not_committed');
    }
    vi.restoreAllMocks();
    installEnvironment();

    // (h) execute: der Vorbereitungslader scheitert typisiert.
    const failingGet = vi
      .spyOn(IDBObjectStore.prototype, 'get')
      .mockImplementation(() => boom() as never);
    const loadFailure = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(loadFailure.ok).toBe(false);
    if (!loadFailure.ok) expect(loadFailure.cloudState).toBe('not_committed');
    failingGet.mockRestore();

    // (i) execute: RPC wirft einen unbekannten Fehler — unknown.
    cloudState.rpcHandler = () => boom();
    const rpcFailure = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(rpcFailure.ok).toBe(false);
    if (!rpcFailure.ok) {
      expect(rpcFailure.reason).toBe('rpc_failed');
      expect(rpcFailure.cloudState).toBe('unknown');
    }

    // (j) execute: lokales Upsert wirft — confirmed.
    installServer();
    localState.upsert = () => boom();
    const upsertFailure = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(upsertFailure.ok).toBe(false);
    if (!upsertFailure.ok) {
      expect(upsertFailure.reason).toBe('local_persist_failed');
      expect(upsertFailure.cloudState).toBe('confirmed');
    }

    // (k) execute: Archivierung wirft — Erfolg mit Warnung.
    localState.upsert = null;
    localState.archive = () => boom();
    const archiveFailure = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(archiveFailure.ok, JSON.stringify(archiveFailure)).toBe(true);
    if (archiveFailure.ok) {
      expect(archiveFailure.archiveWarning).toBe(true);
      expect(archiveFailure.cloudState).toBe('confirmed');
    }
  });

  it('C8: nur echte JSON-Objekte werden gesendet und verglichen', async () => {
    expect(isPlainJsonObject({})).toBe(true);
    expect(isPlainJsonObject(Object.create(null))).toBe(true);
    expect(isPlainJsonObject([])).toBe(false);
    expect(isPlainJsonObject(new Date())).toBe(false);
    expect(isPlainJsonObject(new Map())).toBe(false);
    expect(isPlainJsonObject(new Set())).toBe(false);
    class Beispiel {
      readonly a = 1;
    }
    expect(isPlainJsonObject(new Beispiel())).toBe(false);

    const send = (invoicePayload: unknown) =>
      rpcFinalizePreparedWorkspaceInvoice({
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId: CLIENT_ID,
        invoicePayload: invoicePayload as Record<string, unknown>,
      });

    for (const bad of [
      new Date(),
      new Beispiel(),
      { a: undefined },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
    ]) {
      await expect(send(bad), JSON.stringify(String(bad))).rejects.toBeInstanceOf(
        WorkspaceInvoiceCloudError,
      );
    }
    expect(cloudState.rpcCalls.length).toBe(0);

    // Zwei ungültige Darstellungen dürfen nie als gleich gelten.
    const polluted: Record<string, unknown> = { id: CLIENT_ID };
    Object.defineProperty(polluted, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    cloudState.rpcHandler = (args) => ({
      invoice: polluted,
      row: {
        id: 'cloud-row-1',
        workspace_id: args.p_workspace_id,
        vorgang_id: args.p_vorgang_id,
        client_invoice_id: args.p_client_invoice_id,
        payload: polluted,
        row_version: 1,
      },
    });
    await expect(send({ id: CLIENT_ID, type: 'abschlag', positions: [] })).rejects.toBeInstanceOf(
      WorkspaceInvoiceCloudError,
    );
  });

  it('C9: gleichzeitige Ausführungen verwenden dieselbe Kennung', async () => {
    await seedPrepared();
    installServer({}, false);

    const [first, second] = await Promise.all([
      executePreparedInvoiceFinalization({ identity: identity(), expectedRevision: 2 }),
      executePreparedInvoiceFinalization({ identity: identity(), expectedRevision: 2 }),
    ]);

    expect(cloudState.rpcCalls.length).toBe(2);
    const ids = cloudState.rpcCalls.map((call) => call.args.p_client_invoice_id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(CLIENT_ID);

    // Kein Lauf erzeugt eine neue Kennung oder einen zweiten Rechnungsinhalt.
    const payloads = cloudState.rpcCalls.map((call) => JSON.stringify(call.args.p_invoice));
    expect(new Set(payloads).size).toBe(1);
    for (const result of [first, second]) {
      if (result.ok) {
        expect(result.clientInvoiceId).toBe(CLIENT_ID);
        expect(result.invoice.id).toBe(CLIENT_ID);
      }
    }
    for (const saved of localState.upsertCalls) {
      expect(saved.id).toBe(CLIENT_ID);
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4B2 — Kandidaten-Fingerprint
 * bereits in prepare erzwingen.
 * ========================================================================== */

describe('01P4B2 — Kandidaten-Fingerprint vor begin', () => {
  it('M1: ein fachlich asymmetrischer Entwurf liefert invalid_candidate', async () => {
    const intentRead = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
    const intentGet = vi.spyOn(intentService, 'getInvoiceFinalizeIntent');
    const intentClear = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');

    const result = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildAsymmetricDraft() }),
    );

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_candidate');
      expect(result.detail).toBe('candidate_fingerprint');
    }

    expect(cloudState.rpcCalls.length).toBe(0);
    expect(intentRead).not.toHaveBeenCalled();
    expect(intentGet).not.toHaveBeenCalled();
    expect(intentClear).not.toHaveBeenCalled();
    expect(localState.upsertCalls.length).toBe(0);
    expect(localState.archiveCalls.length).toBe(0);
  });

  it('M2: der aktive Entwurfsdatensatz bleibt nach dem Fehlschlag unberührt', async () => {
    const created = await createInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft(),
      now: '2026-08-21T08:00:00.000Z',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);

    const before = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const result = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildAsymmetricDraft() }),
    );
    expect(result.ok).toBe(false);

    const after = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(after.ok, JSON.stringify(after)).toBe(true);
    if (!after.ok) return;

    expect(after.record.status).toBe('active');
    expect(after.record.revision).toBe(1);
    expect(after.record.finalization).toBeUndefined();
    expect(after.record.preparationRawJson).toBeUndefined();
    expect(after.record.preparationSha256).toBeUndefined();
    expect(after.record.draftRawJson).toBe(before.record.draftRawJson);
    expect(after.record.draftSha256).toBe(before.record.draftSha256);
  });

  it('M3: ein gültiger mengenbasierter Kandidat ist fingerprintgleich', async () => {
    const result = await prepareInvoiceDraftFinalization(prepareInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(buildInvoiceContentFingerprintFromInvoice(result.request.invoice)).toBe(
      result.contentFingerprint,
    );
  });

  it('M4: ein gültiger Pauschalabschlag ist fingerprintgleich', async () => {
    const draft = buildDraft({
      calculationMode: 'fixed_amount',
      fixedAmountNet: 1500,
      positions: [],
    });

    const result = await prepareInvoiceDraftFinalization(prepareInput({ draft }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.request.invoice.calculationMode).toBe('fixed_amount');
    expect(result.request.invoice.positions).toEqual([]);
    expect(buildInvoiceContentFingerprintFromInvoice(result.request.invoice)).toBe(
      result.contentFingerprint,
    );
  });

  it('M5: eine gültige Schlussrechnung ist fingerprintgleich und vollständig', async () => {
    const deductions = [
      {
        invoiceId: 'inv-alt-1',
        invoiceNumber: '2026-0001',
        abschlagNumber: 1,
        date: '2026-07-01',
        subtotal: 100,
        amount: 119,
      },
    ];
    const draft = buildDraft({
      type: 'schluss',
      abschlagNumber: undefined,
      calculationMode: undefined,
      expectedAmendmentSequence: 4,
      previousAbschlagDeductions: deductions,
    });

    const result = await prepareInvoiceDraftFinalization(prepareInput({ draft }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(buildInvoiceContentFingerprintFromInvoice(result.request.invoice)).toBe(
      result.contentFingerprint,
    );
    expect(result.request.invoice.expectedAmendmentSequence).toBe(4);
    expect(result.request.invoice.previousAbschlagDeductions).toEqual(deductions);
    expect(result.request.invoicePayload.expectedAmendmentSequence).toBe(4);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E3B — Projektionsparität für
 * die Schlussrechnung.
 *
 * Die aktive SQL-Fassung von `normalize_workspace_invoice_payload_for_idempotency`
 * (Amendment-Migration) entfernt **zehn** Metaschlüssel, die clientseitige
 * Antwortprojektion bisher nur acht. `expectedAmendmentSequence` bleibt damit
 * in der erwarteten Projektion, fehlt aber im gespeicherten Serverpayload.
 * ========================================================================== */

// Der Datensatzschlüssel trennt bereits über den Rechnungstyp; die Entwurfs-ID
// muss zum Entwurf passen und bleibt deshalb die vorhandene.
const SCHLUSS_IDENTITY = { invoiceType: 'schluss' as const };
const SCHLUSS_AMENDMENT_SEQUENCE = 4;

function buildSchlussDraft(): InvoiceDraft {
  return buildDraft({
    type: 'schluss',
    abschlagNumber: undefined,
    calculationMode: undefined,
    expectedAmendmentSequence: SCHLUSS_AMENDMENT_SEQUENCE,
  });
}

/** Vorbereiteter Schluss-Datensatz im Status `finalizing` (Revision 2). */
async function seedPreparedSchluss(): Promise<PreparedWorkspaceInvoiceFinalizeRequest> {
  const created = await createInvoiceDraftRecord({
    identity: identity(SCHLUSS_IDENTITY),
    draft: buildSchlussDraft(),
    now: '2026-08-22T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);

  const prepared = await prepareInvoiceDraftFinalization(
    prepareInput({ draft: buildSchlussDraft() }),
  );
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) throw new Error('prepare fehlgeschlagen');

  const begun = await beginInvoiceDraftFinalization({
    identity: identity(SCHLUSS_IDENTITY),
    expectedRevision: 1,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request as never,
    approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
    now: PREPARED_AT,
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);
  return prepared.request;
}

describe('01P4E3B — Prepared-Schluss-Projektionsparität', () => {
  it('P1: die erwartete Projektion entspricht dem gespeicherten Serverpayload', async () => {
    const prepared = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildSchlussDraft() }),
    );
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    const sent = prepared.request.invoicePayload;
    expect(sent.expectedAmendmentSequence).toBe(SCHLUSS_AMENDMENT_SEQUENCE);

    // Was der aktive SQL-Vertrag tatsächlich speichert: ohne das Metafeld.
    const storedByServer = serverEcho(sent, prepared.clientInvoiceId);

    expect(buildActualPreparedResponseProjection(storedByServer)).toBe(
      prepared.request.expectedResponseProjectionRawJson,
    );
  });

  it('P2: beide Schreibweisen des Metafelds werden nur aus der Projektion entfernt', () => {
    const base: Record<string, unknown> = {
      id: 'inv-p2',
      type: 'schluss',
      status: 'vorbereitet',
      positions: [],
      subtotal: 100,
      amount: 119,
      taxStatus: 'standard_19',
      date: '2026-08-22',
      createdAt: '2026-08-22T09:00:00.000Z',
      introText: 'bleibt erhalten',
    };
    const reference = buildActualPreparedResponseProjection(base);
    expect(reference).not.toBeNull();
    expect(reference).toContain('introText');

    // Beide Metaschreibweisen verschwinden aus der Projektion.
    expect(
      buildActualPreparedResponseProjection({ ...base, expectedAmendmentSequence: 4 }),
    ).toBe(reference);
    expect(
      buildActualPreparedResponseProjection({ ...base, expected_amendment_sequence: 4 }),
    ).toBe(reference);
    expect(
      buildExpectedPreparedResponseProjection({ ...base, expectedAmendmentSequence: 4 }, 'inv-p2'),
    ).toBe(buildExpectedPreparedResponseProjection(base, 'inv-p2'));

    // Eine echte fachliche Abweichung bleibt ein Mismatch.
    expect(buildActualPreparedResponseProjection({ ...base, amount: 999 })).not.toBe(reference);

    /*
     * Die Snake-Case-Variante ist ausschließlich SQL-/Projektionsparität. Sie
     * wird dadurch **kein** erlaubtes Feld eines Prepared-Requests: der
     * Request-Validator lehnt sie weiterhin als unbekanntes Feld ab.
     */
    expect(
      validatePreparedWorkspaceInvoiceFinalizeRequest({
        kind: PREPARED_FINALIZE_REQUEST_KIND,
        formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId: 'inv-p2',
        invoice: { id: 'inv-p2', expected_amendment_sequence: 4 },
        invoicePayload: { id: 'inv-p2', expected_amendment_sequence: 4 },
        expectedResponseProjectionRawJson: '{}',
      }).ok,
    ).toBe(false);
  });

  it('P3: ein vollständiger Prepared-Schluss-Ablauf gelingt', async () => {
    const request = await seedPreparedSchluss();
    installServer();
    cloudState.rpcCalls = [];
    localState.upsertCalls = [];

    const result = await executePreparedInvoiceFinalization({
      identity: identity(SCHLUSS_IDENTITY),
      expectedRevision: 2,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.cloudState).toBe('confirmed');
    expect(cloudState.rpcCalls.length).toBe(1);

    // Der Request trägt das Metafeld weiterhin exakt.
    const sent = cloudState.rpcCalls[0]?.args.p_invoice as Record<string, unknown>;
    expect(sent.expectedAmendmentSequence).toBe(SCHLUSS_AMENDMENT_SEQUENCE);
    expect(sent).toEqual(request.invoicePayload);

    // Der gespeicherte und zurückgegebene Serverpayload trägt es nicht.
    const echoed = serverEcho(sent, request.clientInvoiceId);
    expect('expectedAmendmentSequence' in echoed).toBe(false);

    // Genau eine lokale Persistenz mit korrektem fachlichem Inhalt.
    expect(localState.upsertCalls.length).toBe(1);
    const saved = localState.upsertCalls[0]!;
    expect(saved.id).toBe(request.clientInvoiceId);
    expect(saved.number).toBe('2026-0007');
    expect(saved.invoiceSequenceNumber).toBe(7);
    expect(saved.type).toBe('schluss');
    expect(saved.status).toBe('vorbereitet');
    expect(saved.expectedAmendmentSequence).toBe(SCHLUSS_AMENDMENT_SEQUENCE);
  });

  it('P4: Fingerprint- und Requestbindung des Metafelds bleiben unverändert', async () => {
    const prepared = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildSchlussDraft() }),
    );
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    /*
     * (a) CONTENT-FINGERPRINT-PARITY-01C — der Geschäfts-Fingerprint bindet das
     * Metafeld **nicht mehr**, und das ist Absicht.
     *
     * Vorher stand hier `.not.toBe(...)`: eine veränderte Sequenz musste einen
     * anderen Fingerprint ergeben. Genau daran ist dieselbe Rechnung lokal und
     * aus der Cloud auseinandergefallen — der Server speichert den Guard
     * ausdrücklich nicht, eine gezogene Schlussrechnung trägt ihn nie.
     *
     * Der Schutz wandert dadurch nicht weg; er lag nie hier. Er sitzt in (b),
     * dem Request-Validator, und im SQL-Guard `invoice_amendment_state_stale`.
     */
    expect(buildInvoiceContentFingerprintFromInvoice(prepared.request.invoice)).toBe(
      prepared.contentFingerprint,
    );
    const tampered = {
      ...prepared.request.invoice,
      expectedAmendmentSequence: SCHLUSS_AMENDMENT_SEQUENCE + 1,
    };
    expect(buildInvoiceContentFingerprintFromInvoice(tampered)).toBe(
      prepared.contentFingerprint,
    );
    expect(prepared.contentFingerprint).not.toContain('expectedAmendmentSequence');

    // (b) Der Request-Validator verlangt das Feld im Schluss-Payload weiterhin.
    const withoutMeta = JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>;
    delete (withoutMeta.invoicePayload as Record<string, unknown>).expectedAmendmentSequence;
    expect(validatePreparedWorkspaceInvoiceFinalizeRequest(withoutMeta).ok).toBe(false);

    /*
     * (c) Ein serverseitiges Überschreiben des Metafelds ist von der
     * Antwortprojektion **konstruktionsbedingt** nicht erkennbar — der Server
     * speichert es nie. Genau deshalb liegt der Schutz bei (a) und (b) sowie
     * beim serverseitigen Amendment-Guard, nicht bei der Projektion. Dieser
     * Fall stand zuvor in B15 und prüfte dort in Wahrheit nur die fehlende
     * Parität.
     */
    await seedPreparedSchluss();
    installServer({ expectedAmendmentSequence: 9 });
    cloudState.rpcCalls = [];
    localState.upsertCalls = [];

    const overridden = await executePreparedInvoiceFinalization({
      identity: identity(SCHLUSS_IDENTITY),
      expectedRevision: 2,
    });
    // Der Ablauf gelingt, weil das Metafeld gar nicht erst zurückkommt …
    expect(overridden.ok, JSON.stringify(overridden)).toBe(true);
    // … und die lokal gespeicherte Rechnung trägt weiterhin den geprüften Wert.
    expect(localState.upsertCalls[0]?.expectedAmendmentSequence).toBe(
      SCHLUSS_AMENDMENT_SEQUENCE,
    );

    /*
     * Die Antwortprojektion ist ausdrücklich **kein** Ersatz für Fingerprint
     * oder Request-Bindung. Der Erhalt im Request selbst ist bereits durch B7
     * und M4 belegt und wird hier nicht dupliziert.
     */
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E3D — Formatversion 2 des
 * **inneren** Prepared-Requests.
 *
 * 01P4E3B hat die Bedeutung von `expectedResponseProjectionRawJson` geändert,
 * ohne die Version zu erhöhen. Der äußere Vorbereitungsumschlag ist davon
 * unberührt und bleibt auf Version 1.
 * ========================================================================== */

describe('01P4E3D — Prepared-Request-Formatversion', () => {
  /*
   * BRANDING-01F-2 — die Version ist auf 3 gestiegen, weil die Feld-Whitelist
   * um `brandingSnapshot` erweitert wurde. Die Zusicherungen bleiben dieselben:
   * genau eine gültige Version, kein Default, kein dualer Leser — insbesondere
   * wird die **vorherige** Version 2 weiterhin abgewiesen.
   */
  it('F1: die innere Request-Version ist 3, die äußere Vorbereitung bleibt 1', () => {
    expect(PREPARED_FINALIZE_REQUEST_FORMAT_VERSION).toBe(3);
    expect(INVOICE_DRAFT_PREPARATION_FORMAT_VERSION).toBe(1);
    // Die Kennung des Requests bleibt unverändert.
    expect(PREPARED_FINALIZE_REQUEST_KIND).toBe(
      'officepilot-workspace-invoice-finalize-request',
    );
  });

  it('F2: der Request-Validator akzeptiert ausschließlich Version 3', async () => {
    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    const base = JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>;
    expect(validatePreparedWorkspaceInvoiceFinalizeRequest(base).ok).toBe(true);

    // `2` steht bewusst in der Liste: Requests der Vorversion werden abgewiesen.
    for (const version of [1, 0, 2, 4, '3', null, true, 2.5] as unknown[]) {
      const result = validatePreparedWorkspaceInvoiceFinalizeRequest({
        ...base,
        formatVersion: version,
      });
      expect(result.ok, JSON.stringify(version)).toBe(false);
      if (!result.ok) {
        expect(result.detail, JSON.stringify(version)).toBe('request.formatVersion:unsupported');
      }
    }

    // Fehlend ⇒ ebenfalls abgelehnt, kein Default.
    const withoutVersion = { ...base };
    delete withoutVersion.formatVersion;
    expect(validatePreparedWorkspaceInvoiceFinalizeRequest(withoutVersion).ok).toBe(false);
  });

  it('F3: eine neue Vorbereitung trägt Version 3 und den E3B-Projektionsvertrag', async () => {
    const prepared = await prepareInvoiceDraftFinalization(
      prepareInput({ draft: buildSchlussDraft() }),
    );
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.request.kind).toBe(PREPARED_FINALIZE_REQUEST_KIND);
    expect(prepared.request.formatVersion).toBe(3);
    // Der Schluss-Payload trägt das Metafeld weiterhin.
    expect(prepared.request.invoicePayload.expectedAmendmentSequence).toBe(
      SCHLUSS_AMENDMENT_SEQUENCE,
    );
    // Die Projektion erwartet es nach dem E3B-Vertrag nicht.
    expect(prepared.request.expectedResponseProjectionRawJson).not.toContain(
      'expectedAmendmentSequence',
    );
    expect(
      buildActualPreparedResponseProjection(
        serverEcho(prepared.request.invoicePayload, prepared.clientInvoiceId),
      ),
    ).toBe(prepared.request.expectedResponseProjectionRawJson);
  });

  it('F4: ein gespeicherter V1-Request blockiert ohne RPC und ohne Persistenz', async () => {
    const created = await createInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft(),
      now: '2026-08-22T08:00:00.000Z',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);

    const prepared = await prepareInvoiceDraftFinalization(prepareInput());
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    // Derselbe Request, aber mit der alten inneren Version — vom Kern regulär
    // serialisiert und gehasht, also formal hashgültig.
    const legacyRequest = {
      ...(JSON.parse(JSON.stringify(prepared.request)) as Record<string, unknown>),
      formatVersion: 1,
    };
    const begun = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: prepared.clientInvoiceId,
      contentFingerprint: prepared.contentFingerprint,
      request: legacyRequest as never,
      approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
      now: PREPARED_AT,
    });
    expect(begun.ok, JSON.stringify(begun)).toBe(true);

    installServer();
    cloudState.rpcCalls = [];
    localState.upsertCalls = [];
    localState.archiveCalls = [];

    const result = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      // Vorhandener Fehlergrund, keine neue Union.
      expect(result.reason).toBe('request_invalid');
      expect(result.detail).toBe('request.formatVersion:unsupported');
      // Behauptet ausdrücklich keinen Cloud-Commit.
      expect(result.cloudState).toBe('not_committed');
    }

    expect(cloudState.rpcCalls.length).toBe(0);
    expect(localState.upsertCalls).toEqual([]);
    expect(localState.archiveCalls).toEqual([]);

    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalizing');
      expect(record.record.revision).toBe(2);
      // Keine neue Kennung.
      expect(record.record.finalization?.clientInvoiceId).toBe(prepared.clientInvoiceId);
      // Der gespeicherte Rohtext bleibt V1 — nichts wurde umgeschrieben.
      expect(record.record.preparationRawJson).toContain('"formatVersion":1');
    }
  });

  it('F5: Abschlag und Schluss bleiben mit der aktuellen Version erfolgreich', async () => {
    // (a) Abschlag.
    const abschlagRequest = await seedPrepared();
    installServer();
    cloudState.rpcCalls = [];
    localState.upsertCalls = [];

    const abschlag = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(abschlag.ok, JSON.stringify(abschlag)).toBe(true);
    expect(cloudState.rpcCalls.length).toBe(1);
    expect(cloudState.rpcCalls[0]?.args.p_invoice).toEqual(abschlagRequest.invoicePayload);
    expect(localState.upsertCalls.length).toBe(1);

    // (b) Schluss.
    const schlussRequest = await seedPreparedSchluss();
    installServer();
    cloudState.rpcCalls = [];
    localState.upsertCalls = [];

    const schluss = await executePreparedInvoiceFinalization({
      identity: identity(SCHLUSS_IDENTITY),
      expectedRevision: 2,
    });
    expect(schluss.ok, JSON.stringify(schluss)).toBe(true);
    expect(cloudState.rpcCalls.length).toBe(1);

    const sent = cloudState.rpcCalls[0]?.args.p_invoice as Record<string, unknown>;
    // Der RPC erhält das Metafeld weiterhin …
    expect(sent.expectedAmendmentSequence).toBe(SCHLUSS_AMENDMENT_SEQUENCE);
    expect(sent).toEqual(schlussRequest.invoicePayload);
    // … die Antwortprojektion erwartet es weiterhin nicht.
    expect(schlussRequest.expectedResponseProjectionRawJson).not.toContain(
      'expectedAmendmentSequence',
    );
    expect(localState.upsertCalls.length).toBe(1);
  });

  it('F6: der gespeicherte Rohtext trägt Version 3 und bleibt unverändert', async () => {
    await seedPrepared();

    const before = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const rawJson = before.record.preparationRawJson!;
    const sha = before.record.preparationSha256!;
    expect(rawJson).toContain('"formatVersion":3');
    expect(JSON.parse(rawJson).kind).toBe(INVOICE_DRAFT_PREPARATION_KIND);
    // Der äußere Umschlag bleibt Version 1.
    expect(JSON.parse(rawJson).formatVersion).toBe(1);
    expect(JSON.parse(rawJson).request.formatVersion).toBe(3);

    // Der gespeicherte Hash passt exakt zum gespeicherten Rohtext.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawJson));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(sha).toBe(hex);

    installServer();
    const executed = await executePreparedInvoiceFinalization({
      identity: identity(),
      expectedRevision: 2,
    });
    expect(executed.ok, JSON.stringify(executed)).toBe(true);

    const after = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(after.ok).toBe(true);
    if (after.ok) {
      // Execute verändert keinen gespeicherten Rohtext.
      expect(after.record.preparationRawJson).toBe(rawJson);
      expect(after.record.preparationSha256).toBe(sha);
    }
  });
});
