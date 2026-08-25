import type { SupabaseClient } from '@supabase/supabase-js';
import type { VorgangInvoice, VorgangInvoiceLine } from '../../types/models';
import { getSupabaseClient } from '../../lib/supabase';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { formatInvoiceNumber } from '../invoiceNumberService';
import {
  canonicalJsonStringify,
  isCanonicalJsonObject as isCanonicalPreparedJsonObject,
  isPlainJsonObject as isPreparedJsonObject,
} from './invoicePreparedResponseProjection';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';

/**
 * CLOUD-ORDER-CHAIN-03A/03B2 – thin binding for finalize + pull workspace invoices.
 *
 * Note on SyncAdapter.reserveInvoiceNumber:
 * Separating number reservation from invoice insert is unsafe for multi-device.
 * SupabaseSyncAdapter must keep throwing on reserveInvoiceNumber; use this RPC instead.
 */

export type WorkspaceInvoiceCloudErrorCode =
  | 'auth'
  | 'rls'
  | 'validation'
  | 'idempotency_conflict'
  | 'network'
  | 'unknown';

export class WorkspaceInvoiceCloudError extends Error {
  readonly code: WorkspaceInvoiceCloudErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: WorkspaceInvoiceCloudErrorCode, retryable = false) {
    super(message);
    this.name = 'WorkspaceInvoiceCloudError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WorkspaceInvoiceFinalizeInput {
  workspaceId: string;
  vorgangId: string;
  /** Stable idempotency key — typically VorgangInvoice.id */
  clientInvoiceId: string;
  invoice: VorgangInvoice;
}

/**
 * 01P4B — bereits vollständig vorbereiteter Payload. Er wird unverändert
 * gesendet; `buildWorkspaceInvoiceFinalizePayload` läuft hier nie.
 */
export interface WorkspaceInvoicePreparedFinalizeInput {
  workspaceId: string;
  vorgangId: string;
  clientInvoiceId: string;
  invoicePayload: Record<string, unknown>;
}

export interface WorkspaceInvoicePreparedFinalizeResult {
  rawInvoicePayload: Record<string, unknown>;
  rawRow: Record<string, unknown>;
  idempotentReplay: boolean;
  rowVersion: number;
  cloudInvoiceId: string;
}

export interface WorkspaceInvoiceFinalizeResult {
  invoice: VorgangInvoice;
  idempotentReplay: boolean;
  rowVersion: number;
  cloudInvoiceId: string;
}

export interface WorkspaceInvoicePullRow {
  id: string;
  workspace_id: string;
  vorgang_id: string;
  client_invoice_id: string;
  invoice_number: string;
  invoice_year: number;
  invoice_sequence_number: number;
  invoice_type: string;
  invoice_status: string;
  payload: Record<string, unknown>;
  row_version: number;
  created_at: string;
  updated_at: string;
  updated_by?: string | null;
}

/*
 * 01P4E1B — der frühere Alias `WorkspaceInvoiceRow` entfällt: die
 * Finalisierungsantwort wird nicht mehr auf einen Zeilentyp gecastet, sondern
 * feldweise geprüft. Der Pull-Zeilentyp `WorkspaceInvoicePullRow` bleibt
 * unverändert.
 */

export interface MappedWorkspaceInvoicePull {
  workspaceId: string;
  vorgangId: string;
  clientInvoiceId: string;
  cloudInvoiceId: string;
  rowVersion: number;
  invoice: VorgangInvoice;
}

function getClient(client?: SupabaseClient | null): SupabaseClient {
  const resolved = client ?? getSupabaseClient();
  if (!resolved) {
    throw new WorkspaceInvoiceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  }
  return resolved;
}

function classifyInvoiceCloudError(error: { message?: string; code?: string }): WorkspaceInvoiceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet') || error.code === 'PGRST301') {
    return new WorkspaceInvoiceCloudError(message, 'auth', false);
  }
  if (
    message.includes('Kein Zugriff') ||
    message.includes('permission') ||
    error.code === '42501'
  ) {
    return new WorkspaceInvoiceCloudError(message, 'rls', false);
  }
  if (message.includes('Idempotenzkonflikt')) {
    return new WorkspaceInvoiceCloudError(message, 'idempotency_conflict', false);
  }
  if (
    message.includes('fehlt') ||
    message.includes('positions') ||
    message.includes('type') ||
    message.includes('Vorgang gehört nicht')
  ) {
    return new WorkspaceInvoiceCloudError(message, 'validation', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceInvoiceCloudError(message, 'network', true);
  }
  if (error instanceof WorkspaceCloudError) {
    return new WorkspaceInvoiceCloudError(
      error.message,
      error.code === 'auth' || error.code === 'rls' || error.code === 'network'
        ? error.code
        : 'unknown',
      error.retryable,
    );
  }
  return new WorkspaceInvoiceCloudError(message, 'unknown', true);
}

const INVOICE_SENT_VIA = new Set(['email', 'post', 'persoenlich', 'portal', 'sonstige']);

const INVOICE_STATUSES = new Set(['entwurf', 'vorbereitet', 'versendet']);
const INVOICE_TYPES = new Set([
  'rechnung',
  'abschlag',
  'teilrechnung',
  'schluss',
  'gutschrift',
  'storno',
]);

function cloneLine(line: VorgangInvoiceLine): VorgangInvoiceLine {
  return { ...line };
}

/**
 * Build RPC invoice JSON from existing VorgangInvoice.
 * Strips payments and archive/PDF references — not part of 03A.
 * Number fields may be present locally but are reassigned by the server.
 */
export function buildWorkspaceInvoiceFinalizePayload(invoice: VorgangInvoice): Record<string, unknown> {
  const {
    payments: _payments,
    paymentStatus: _paymentStatus,
    archiveDocumentId: _archiveDocumentId,
    ...rest
  } = invoice;

  const payload: Record<string, unknown> = {
    ...rest,
    positions: (invoice.positions ?? []).map(cloneLine),
    previousAbschlagDeductions: (invoice.previousAbschlagDeductions ?? []).map((d) => ({ ...d })),
    legalNotices: [...(invoice.legalNotices ?? [])],
    customerSnapshot: invoice.customerSnapshot ? { ...invoice.customerSnapshot } : undefined,
    companySnapshot: invoice.companySnapshot
      ? (() => {
          const { logoDataUrl: _logo, ...profile } = invoice.companySnapshot;
          return profile;
        })()
      : undefined,
  };

  // Schluss: send frozen expectedAmendmentSequence only (camelCase). Never send snake_case twin.
  if (invoice.type === 'schluss') {
    payload.expectedAmendmentSequence = invoice.expectedAmendmentSequence ?? 0;
  } else {
    delete payload.expectedAmendmentSequence;
  }
  delete payload.expected_amendment_sequence;

  return payload;
}

export function buildWorkspaceInvoiceFinalizeInput(
  workspaceId: string,
  vorgangId: string,
  invoice: VorgangInvoice,
): WorkspaceInvoiceFinalizeInput {
  return {
    workspaceId,
    vorgangId,
    clientInvoiceId: invoice.id,
    invoice,
  };
}

/**
 * 01P4D2B2 — optionales Textfeld aus dem Cloud-Payload.
 *
 * Ein Wahrheitswerttest verlöre den **leeren** String und machte damit die
 * gespeicherte Antwortprojektion unrekonstruierbar. Übernommen wird deshalb
 * genau dann, wenn wirklich ein String vorliegt — ohne Trimmung, ohne
 * Ersatztext und ohne stille Umwandlung fremder Typen.
 */
function optionalCloudText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Pflichttext: fehlt oder ist kein String, bleibt er leer — nie erfunden. */
function requiredCloudText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Endliche Zahl oder nichts — keine Umwandlung aus Text. */
function optionalCloudNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Nicht negative ganze Zahl, sonst nichts. */
function optionalCloudSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Reines JSON-Objekt oder nichts — kein Array, keine Klasseninstanz. */
function optionalCloudObject<T>(value: unknown): T | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as T;
}

/** Liste echter Strings — keine Teilreparatur, keine Umwandlung. */
function optionalCloudTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string') ? [...(value as string[])] : undefined;
}

export function mapCloudPayloadToVorgangInvoice(payload: Record<string, unknown>): VorgangInvoice {
  const positionsRaw = Array.isArray(payload.positions)
    ? (payload.positions as VorgangInvoiceLine[])
    : [];
  return {
    id: requiredCloudText(payload.id),
    number: requiredCloudText(payload.number),
    type: payload.type as VorgangInvoice['type'],
    abschlagNumber:
      typeof payload.abschlagNumber === 'number' ? payload.abschlagNumber : undefined,
    invoiceSequenceNumber:
      typeof payload.invoiceSequenceNumber === 'number'
        ? payload.invoiceSequenceNumber
        : undefined,
    positions: positionsRaw.map(cloneLine),
    calculationMode:
      payload.calculationMode === 'fixed_amount' || payload.calculationMode === 'quantity_based'
        ? payload.calculationMode
        : undefined,
    fixedAmountNet:
      typeof payload.fixedAmountNet === 'number' && Number.isFinite(payload.fixedAmountNet)
        ? Number(payload.fixedAmountNet)
        : undefined,
    subtotal: optionalCloudNumber(payload.subtotal) as number,
    taxStatus: optionalCloudText(payload.taxStatus) as VorgangInvoice['taxStatus'],
    amount: optionalCloudNumber(payload.amount) as number,
    status: (payload.status as VorgangInvoice['status']) ?? 'vorbereitet',
    date: requiredCloudText(payload.date),
    // Kein erfundener lokaler Zeitpunkt: ein fehlendes Cloud-createdAt bleibt
    // leer und lässt Projektion und Fingerprint fail-closed scheitern.
    createdAt: requiredCloudText(payload.createdAt),
    issueDate: optionalCloudText(payload.issueDate),
    servicePeriodFrom: optionalCloudText(payload.servicePeriodFrom),
    servicePeriodTo: optionalCloudText(payload.servicePeriodTo),
    paymentDueDate: optionalCloudText(payload.paymentDueDate),
    paymentTermsText: optionalCloudText(payload.paymentTermsText),
    skontoText: optionalCloudText(payload.skontoText),
    customerSnapshot: optionalCloudObject<VorgangInvoice['customerSnapshot']>(
      payload.customerSnapshot,
    ),
    companySnapshot: optionalCloudObject<VorgangInvoice['companySnapshot']>(
      payload.companySnapshot,
    ),
    legalNotices: optionalCloudTextList(payload.legalNotices),
    previousAbschlagDeductions: Array.isArray(payload.previousAbschlagDeductions)
      ? (payload.previousAbschlagDeductions as VorgangInvoice['previousAbschlagDeductions'])
      : undefined,
    introText: optionalCloudText(payload.introText),
    closingText: optionalCloudText(payload.closingText),
    baustelle: optionalCloudText(payload.baustelle),
    vorgangTitle: optionalCloudText(payload.vorgangTitle),
    sentAt: optionalCloudText(payload.sentAt),
    sentVia: INVOICE_SENT_VIA.has(String(payload.sentVia))
      ? (payload.sentVia as VorgangInvoice['sentVia'])
      : undefined,
    sentNote: optionalCloudText(payload.sentNote),
    // 01P4D2B3 — projektionsrelevant und deshalb erhalten.
    cancelledAt: optionalCloudText(payload.cancelledAt),
    cancelReason: optionalCloudText(payload.cancelReason),
    expectedAmendmentSequence: optionalCloudSequence(payload.expectedAmendmentSequence),
    // Intentionally omit payments / archiveDocumentId in 03A cloud mapping.
  };
}

/** Exported for tests — mirrors SQL format_workspace_invoice_number. */
export function formatWorkspaceInvoiceNumber(year: number, sequence: number): string {
  return formatInvoiceNumber(year, sequence);
}

export function parseWorkspaceInvoicePullRow(
  raw: unknown,
): WorkspaceInvoicePullRow | null {
  if (!isPreparedJsonObject(raw)) return null;
  const row = raw as Record<string, unknown>;

  /*
   * 01P4D2B4 — strikte Rohdatentypen: keine `String(...)`- oder
   * `Number(...)`-Coercion mehr. Ein falscher Typ macht die Zeile ungültig,
   * damit `mapPullRowsIsolated` sie **vor** Mapping und Merge zählt.
   */
  /*
   * 01P4E1C — kein Trimmen: eine Spalte mit führendem oder folgendem
   * Whitespace ist keine gültige Spalte, sondern ein Datenfehler. Der Wert
   * wird abgewiesen statt normalisiert.
   */
  const textColumn = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null;
  const integerColumn = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;

  const id = textColumn(row.id);
  const workspaceId = textColumn(row.workspace_id);
  const vorgangId = textColumn(row.vorgang_id);
  const clientInvoiceId = textColumn(row.client_invoice_id);
  const invoiceNumber = textColumn(row.invoice_number);
  const invoiceType = textColumn(row.invoice_type);
  const invoiceStatus = textColumn(row.invoice_status);
  const payload = isPreparedJsonObject(row.payload) ? row.payload : null;
  const year = integerColumn(row.invoice_year);
  const sequence = integerColumn(row.invoice_sequence_number);
  const rowVersion = row.row_version === undefined ? 1 : integerColumn(row.row_version);

  if (
    !id ||
    !workspaceId ||
    !vorgangId ||
    !clientInvoiceId ||
    !invoiceNumber ||
    !invoiceType ||
    !invoiceStatus ||
    !payload ||
    year === null ||
    // Dieselben Grenzen wie die SQL-Bedingung workspace_invoices_year_check.
    year < 2000 ||
    year > 2100 ||
    sequence === null ||
    sequence <= 0 ||
    rowVersion === null ||
    rowVersion <= 0 ||
    !INVOICE_TYPES.has(invoiceType) ||
    !INVOICE_STATUSES.has(invoiceStatus)
  ) {
    return null;
  }

  // Der Payload wird streng geprüft — nicht repariert und nicht beschnitten.
  if (!validateWorkspaceInvoiceCloudPayload(payload).ok) {
    return null;
  }

  /*
   * 01P4E1C — die autoritativen Zeilenspalten und ihre im Payload duplizierten
   * Felder müssen exakt übereinstimmen. Bisher gewann stillschweigend die
   * Spalte; ein Widerspruch blieb unsichtbar. Jetzt ist er ein Datenfehler.
   * `invoiceSequenceNumber` wird geprüft, sobald es vorhanden ist — ein
   * Altbeleg ohne dieses optionale Feld bleibt gültig.
   */
  if (
    payload.id !== clientInvoiceId ||
    payload.number !== invoiceNumber ||
    payload.type !== invoiceType ||
    payload.status !== invoiceStatus ||
    (payload.invoiceSequenceNumber !== undefined &&
      payload.invoiceSequenceNumber !== sequence)
  ) {
    return null;
  }

  return {
    id,
    workspace_id: workspaceId,
    vorgang_id: vorgangId,
    client_invoice_id: clientInvoiceId,
    invoice_number: invoiceNumber,
    invoice_year: year,
    invoice_sequence_number: sequence,
    invoice_type: invoiceType,
    invoice_status: invoiceStatus,
    payload,
    row_version: Number.isFinite(rowVersion) ? rowVersion : 1,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    updated_by: row.updated_by == null ? null : String(row.updated_by),
  };
}

/**
 * Map a pull row into VorgangInvoice.
 * Identity/number/type/status come from row columns; body from payload.
 * Payments and PDF/archive fields are never reconstructed from cloud.
 */
export function mapWorkspaceInvoicePullRowToVorgangInvoice(
  row: WorkspaceInvoicePullRow,
): MappedWorkspaceInvoicePull {
  const fromPayload = mapCloudPayloadToVorgangInvoice(row.payload);
  const invoice: VorgangInvoice = {
    ...fromPayload,
    id: row.client_invoice_id,
    number: row.invoice_number,
    invoiceSequenceNumber: row.invoice_sequence_number,
    type: row.invoice_type as VorgangInvoice['type'],
    status: row.invoice_status as VorgangInvoice['status'],
  };
  // Explicitly drop comfort/local-only fields from cloud mapping.
  delete (invoice as { payments?: unknown }).payments;
  delete (invoice as { paymentStatus?: unknown }).paymentStatus;
  delete (invoice as { archiveDocumentId?: unknown }).archiveDocumentId;

  return {
    workspaceId: row.workspace_id,
    vorgangId: row.vorgang_id,
    clientInvoiceId: row.client_invoice_id,
    cloudInvoiceId: row.id,
    rowVersion: row.row_version,
    invoice,
  };
}

/** Raw pull rows from RPC (typed mapping happens client-side with isolation). */
export async function rpcPullWorkspaceInvoiceRows(
  workspaceId: string,
  options?: { since?: string | null; client?: SupabaseClient | null },
): Promise<unknown[]> {
  if (!workspaceId.trim()) {
    throw new WorkspaceInvoiceCloudError('workspace_id fehlt', 'validation', false);
  }

  try {
    const supabase = getClient(options?.client);
    const { data, error } = await supabase.rpc('pull_workspace_invoices', {
      p_workspace_id: workspaceId,
      p_since: options?.since ?? null,
    });

    if (error) {
      throw classifyInvoiceCloudError(error);
    }

    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      throw error;
    }
    throw classifyInvoiceCloudError(
      error instanceof Error ? { message: error.message } : { message: 'Unbekannter Fehler' },
    );
  }
}

/** INVOICE-SENT-CLOUD-DURABILITY-04B1 — die vom Nutzer bestätigten Versandangaben. */
export interface WorkspaceInvoiceSentUpdateInput {
  workspaceId: string;
  /** Stabile Client-Kennung — nie die Rechnungsnummer. */
  clientInvoiceId: string;
  sentAt: string;
  sentVia: NonNullable<VorgangInvoice['sentVia']>;
  sentNote?: string;
}

/**
 * INVOICE-SENT-CLOUD-DURABILITY-04B1 — schreibt die Versandwahrheit dauerhaft.
 *
 * Übertragen werden ausschließlich die drei bestätigten Versandfelder. Weder
 * Positionen noch Beträge, Nummer, Typ oder Datum verlassen den Client — der
 * Server kann sie deshalb nicht überschreiben, und der Finalisierungs-Fingerprint
 * bleibt unberührt. Zahlungen sind nicht Teil dieses Wegs.
 */
export async function rpcUpdateWorkspaceInvoiceSent(
  input: WorkspaceInvoiceSentUpdateInput,
  options?: { client?: SupabaseClient | null },
): Promise<MappedWorkspaceInvoicePull> {
  if (!input.workspaceId.trim()) {
    throw new WorkspaceInvoiceCloudError('workspace_id fehlt', 'validation', false);
  }
  if (!input.clientInvoiceId.trim()) {
    throw new WorkspaceInvoiceCloudError('client_invoice_id fehlt', 'validation', false);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sentAt.trim())) {
    throw new WorkspaceInvoiceCloudError('sent_at ungültig', 'validation', false);
  }
  if (!INVOICE_SENT_VIA.has(String(input.sentVia))) {
    throw new WorkspaceInvoiceCloudError('sent_via ungültig', 'validation', false);
  }

  let data: unknown;
  try {
    const supabase = getClient(options?.client);
    const response = await supabase.rpc('update_workspace_invoice_sent', {
      p_workspace_id: input.workspaceId,
      p_client_invoice_id: input.clientInvoiceId,
      p_sent_at: input.sentAt.trim(),
      p_sent_via: input.sentVia,
      p_sent_note: input.sentNote?.trim() || null,
    });
    if (response.error) {
      throw classifyInvoiceCloudError(response.error);
    }
    data = response.data;
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) throw error;
    throw classifyInvoiceCloudError(
      error instanceof Error ? { message: error.message } : { message: 'Unbekannter Fehler' },
    );
  }

  /**
   * INVOICE-SENT-CLOUD-DURABILITY-04B1U — die Antwort muss die Mutation beweisen.
   *
   * Zuvor genügte eine gültige Zeile desselben Workspace. Auf dem Realgerät kam
   * genau das zurück — eine unveränderte Zeile mit `vorbereitet` —, und der
   * Client meldete Erfolg. Zwei Sprints lang blieb dadurch unsichtbar, dass die
   * Cloud-Zeile nie geschrieben wurde.
   *
   * Erfolg heißt jetzt: genau eine Zeile, genau diese Rechnung, genau dieser
   * Versandzustand.
   */
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) {
    throw new WorkspaceInvoiceCloudError(
      'Sent-Update hat keine eindeutige Zeile geliefert',
      'validation',
      false,
    );
  }

  const parsed = parseWorkspaceInvoicePullRow(rows[0]);
  if (
    !parsed ||
    parsed.workspace_id !== input.workspaceId ||
    parsed.client_invoice_id !== input.clientInvoiceId ||
    parsed.invoice_status !== 'versendet' ||
    parsed.payload.status !== 'versendet' ||
    parsed.payload.sentAt !== input.sentAt.trim() ||
    parsed.payload.sentVia !== input.sentVia
  ) {
    throw new WorkspaceInvoiceCloudError(
      'Sent-Update wurde von der Cloud nicht bestätigt',
      'validation',
      false,
    );
  }

  /*
   * Die Notiz getrennt geprüft: Ohne Notiz darf der Schlüssel schlicht fehlen —
   * ein gespeichertes `null` wäre für den Pull-Validator ohnehin ungültig und
   * gilt hier deshalb nie als Erfolg.
   */
  const expectedNote = input.sentNote?.trim() || undefined;
  const actualNote = parsed.payload.sentNote;
  if (expectedNote === undefined ? actualNote !== undefined : actualNote !== expectedNote) {
    throw new WorkspaceInvoiceCloudError(
      'Sent-Update hat die Versandnotiz nicht bestätigt',
      'validation',
      false,
    );
  }

  return mapWorkspaceInvoicePullRowToVorgangInvoice(parsed);
}

export async function rpcPullWorkspaceInvoices(
  workspaceId: string,
  options?: { since?: string | null; client?: SupabaseClient | null },
): Promise<MappedWorkspaceInvoicePull[]> {
  const rows = await rpcPullWorkspaceInvoiceRows(workspaceId, options);
  const mapped: MappedWorkspaceInvoicePull[] = [];
  for (const raw of rows) {
    const parsed = parseWorkspaceInvoicePullRow(raw);
    if (!parsed || parsed.workspace_id !== workspaceId) continue;
    mapped.push(mapWorkspaceInvoicePullRowToVorgangInvoice(parsed));
  }
  return mapped;
}

/**
 * 01P4B — sendet einen bereits vorbereiteten Payload **unverändert**.
 *
 * `buildWorkspaceInvoiceFinalizePayload` läuft hier bewusst nicht: der Inhalt
 * wurde vor `begin` erzeugt und darf durch ein späteres Appupdate nicht mehr
 * verändert werden. Die verlustbehaftete Abbildung auf `VorgangInvoice` ist
 * für diesen Pfad kein Beweis — deshalb wird die Rohantwort herausgegeben.
 */
/**
 * 01P4E1E — gemeinsame, modulprivate Hüllenprüfung für **beide**
 * Finalisierungswege. Sie prüft nur, was in beiden Verträgen identisch ist:
 * `data` als reines Objekt, `idempotent_replay` als echtes Boolean und `row`
 * als reines Objekt. Alles Weitere bleibt beim jeweiligen Aufrufer. Keine
 * öffentliche API, keine Abschwächung des Legacy-Vertrags.
 */
function readFinalizeEnvelope(data: unknown): {
  idempotentReplay: boolean;
  row: Record<string, unknown>;
  rowVersion: number;
} {
  if (!isPreparedJsonObject(data)) {
    throw new WorkspaceInvoiceCloudError(
      'Ungültige Server-Antwort bei Rechnungsfinalisierung (envelope:not_object).',
      'unknown',
      false,
    );
  }
  const idempotentReplay = data.idempotent_replay;
  if (typeof idempotentReplay !== 'boolean') {
    throw new WorkspaceInvoiceCloudError(
      'Ungültige Server-Antwort bei Rechnungsfinalisierung (idempotent_replay:not_boolean).',
      'unknown',
      false,
    );
  }
  if (!isPreparedJsonObject(data.row)) {
    throw new WorkspaceInvoiceCloudError(
      'Ungültige Server-Antwort bei Rechnungsfinalisierung (row:not_object).',
      'unknown',
      false,
    );
  }
  /*
   * `row_version` ist in **beiden** Finalisierungswegen Pflicht — anders als im
   * normalen Pull, wo ein fehlender Wert als 1 gilt. Ein frisch geschriebener
   * Datensatz kennt seine Version.
   */
  const rowVersion = data.row.row_version;
  if (typeof rowVersion !== 'number' || !Number.isInteger(rowVersion) || rowVersion <= 0) {
    throw new WorkspaceInvoiceCloudError(
      'Ungültige Server-Antwort bei Rechnungsfinalisierung (row.row_version:not_positive_integer).',
      'unknown',
      false,
    );
  }
  return { idempotentReplay, row: data.row, rowVersion };
}

/**
 * 01P4E1E — **Spalten**vertrag der Antwortzeile, ohne den Payload-Inhalt zu
 * bewerten. Er ist dem Spaltenteil von `parseWorkspaceInvoicePullRow`
 * nachweislich gleichwertig: kanonische Texte ohne Rand-Whitespace, dieselben
 * Jahresgrenzen, Sequenz > 0, gültige Aufzählungen, reiner Payload und
 * dieselben fünf Spalten-/Payload-Bindungen.
 *
 * Der Prepared-Pfad darf den Payload-**Inhalt** hier nicht ablehnen: eine
 * inhaltliche Abweichung muss den Dienst als `cloud_response_mismatch` mit
 * `cloudState: 'confirmed'` erreichen, damit die Wiederaufnahme über Reload
 * läuft und nicht als wiederholbarer RPC-Fehler gilt.
 */
function readFinalizeResponseRowColumns(row: Record<string, unknown>): {
  id: string;
  workspace_id: string;
  vorgang_id: string;
  client_invoice_id: string;
  invoice_number: string;
  invoice_sequence_number: number;
  payload: Record<string, unknown>;
} {
  const reject = (detail: string): never => {
    throw new WorkspaceInvoiceCloudError(
      `Ungültige Server-Antwort bei Rechnungsfinalisierung (${detail}).`,
      'unknown',
      false,
    );
  };
  const text = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      reject(`${path}:not_canonical_text`);
    }
    return value as string;
  };
  const integer = (value: unknown, path: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value)) reject(`${path}:not_integer`);
    return value as number;
  };

  const id = text(row.id, 'row.id');
  const workspaceId = text(row.workspace_id, 'row.workspace_id');
  const vorgangId = text(row.vorgang_id, 'row.vorgang_id');
  const clientInvoiceId = text(row.client_invoice_id, 'row.client_invoice_id');
  const invoiceNumber = text(row.invoice_number, 'row.invoice_number');
  const invoiceType = text(row.invoice_type, 'row.invoice_type');
  const invoiceStatus = text(row.invoice_status, 'row.invoice_status');
  const year = integer(row.invoice_year, 'row.invoice_year');
  // Dieselben Grenzen wie die SQL-Bedingung workspace_invoices_year_check.
  if (year < 2000 || year > 2100) reject('row.invoice_year:out_of_range');
  const sequence = integer(row.invoice_sequence_number, 'row.invoice_sequence_number');
  if (sequence <= 0) reject('row.invoice_sequence_number:not_positive');
  if (!INVOICE_TYPES.has(invoiceType)) reject('row.invoice_type:unknown_value');
  if (!INVOICE_STATUSES.has(invoiceStatus)) reject('row.invoice_status:unknown_value');
  if (!isPreparedJsonObject(row.payload)) reject('row.payload:not_object');
  const payload = row.payload as Record<string, unknown>;

  // Dieselben fünf Spalten-/Payload-Bindungen wie im Pull.
  if (payload.id !== clientInvoiceId) reject('payload.id:mismatch');
  if (payload.number !== invoiceNumber) reject('payload.number:mismatch');
  if (payload.type !== invoiceType) reject('payload.type:mismatch');
  if (payload.status !== invoiceStatus) reject('payload.status:mismatch');
  if (
    payload.invoiceSequenceNumber !== undefined &&
    payload.invoiceSequenceNumber !== sequence
  ) {
    reject('payload.invoiceSequenceNumber:mismatch');
  }

  return {
    id,
    workspace_id: workspaceId,
    vorgang_id: vorgangId,
    client_invoice_id: clientInvoiceId,
    invoice_number: invoiceNumber,
    invoice_sequence_number: sequence,
    payload,
  };
}

export async function rpcFinalizePreparedWorkspaceInvoice(
  input: WorkspaceInvoicePreparedFinalizeInput,
  client?: SupabaseClient | null,
): Promise<WorkspaceInvoicePreparedFinalizeResult> {
  if (!input.workspaceId.trim()) {
    throw new WorkspaceInvoiceCloudError('workspace_id fehlt', 'validation', false);
  }
  if (!input.vorgangId.trim()) {
    throw new WorkspaceInvoiceCloudError('vorgang_id fehlt', 'validation', false);
  }
  if (!input.clientInvoiceId.trim()) {
    throw new WorkspaceInvoiceCloudError('client_invoice_id fehlt', 'validation', false);
  }
  // Nur ein wirklich einfaches, kanonisch serialisierbares JSON-Objekt wird
  // gesendet — keine Klasseninstanz, kein verbotener Schlüssel, kein
  // `undefined` und kein nicht endlicher Wert.
  if (!isCanonicalPreparedJsonObject(input.invoicePayload)) {
    throw new WorkspaceInvoiceCloudError('invoice payload fehlt', 'validation', false);
  }

  try {
    const supabase = getClient(client);
    const { data, error } = await supabase.rpc('finalize_workspace_invoice', {
      p_workspace_id: input.workspaceId,
      p_vorgang_id: input.vorgangId,
      p_client_invoice_id: input.clientInvoiceId,
      // Unverändert — kein Builder, keine Normalisierung, keine Uhrzeit.
      p_invoice: input.invoicePayload,
    });

    if (error) {
      throw classifyInvoiceCloudError(error);
    }

    /*
     * 01P4E1E — dieselbe strikte Antwortgrenze wie im Legacy-Pfad: reine
     * Objekte, echtes Boolean, vollständige Zeile über den Pull-Zeilenvertrag,
     * kanonische Kennung, ganzzahlige Version — ohne jede Coercion und ohne
     * Defaults. Ein Ergebnis entsteht erst nach sämtlichen Prüfungen.
     */
    const { idempotentReplay, row: rawRow, rowVersion } = readFinalizeEnvelope(data);

    const rawInvoicePayload = (data as Record<string, unknown>).invoice;
    if (!isCanonicalPreparedJsonObject(rawInvoicePayload)) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung (invoice:not_canonical).',
        'unknown',
        false,
      );
    }

    // Die vollständige Zeile — Spaltenvertrag wie beim Pull, ohne Inhaltsurteil.
    const parsedRow = readFinalizeResponseRowColumns(rawRow);

    /*
     * Der Vergleich zwischen `row.payload` und `data.invoice` wird **nie**
     * übersprungen: ein fehlender oder `null`-Payload scheitert bereits am
     * Zeilenvertrag oben.
     */
    const rowPayloadJson = canonicalJsonStringify(parsedRow.payload);
    const invoicePayloadJson = canonicalJsonStringify(rawInvoicePayload);
    if (
      rowPayloadJson === null ||
      invoicePayloadJson === null ||
      rowPayloadJson !== invoicePayloadJson
    ) {
      throw new WorkspaceInvoiceCloudError(
        'Server-Antwort und gespeicherte Zeile stimmen nicht überein.',
        'unknown',
        false,
      );
    }

    /*
     * Bindung an die Anfrage. Die fünf Spalten-/Payload-Bindungen hat der
     * Zeilenvertrag bereits geprüft; hier folgt die Bindung an Workspace,
     * Vorgang und Kennung — plus die für einen frischen Abschluss zwingende
     * Sequenz, die im normalen Pull optional bleibt.
     */
    if (
      parsedRow.workspace_id !== input.workspaceId ||
      parsedRow.vorgang_id !== input.vorgangId ||
      parsedRow.client_invoice_id !== input.clientInvoiceId ||
      rawInvoicePayload.id !== input.clientInvoiceId
    ) {
      throw new WorkspaceInvoiceCloudError(
        'Server-Antwort gehört zu einer anderen Rechnung.',
        'unknown',
        false,
      );
    }

    const payloadSequence = rawInvoicePayload.invoiceSequenceNumber;
    if (
      typeof payloadSequence !== 'number' ||
      !Number.isInteger(payloadSequence) ||
      payloadSequence <= 0 ||
      payloadSequence !== parsedRow.invoice_sequence_number
    ) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung (invoice.invoiceSequenceNumber:invalid).',
        'unknown',
        false,
      );
    }

    // Rückgabewerte ausschließlich aus der validierten Zeile.
    return {
      rawInvoicePayload,
      rawRow,
      idempotentReplay,
      rowVersion,
      cloudInvoiceId: parsedRow.id,
    };
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      throw error;
    }
    throw classifyInvoiceCloudError(error as { message?: string; code?: string });
  }
}

export async function rpcFinalizeWorkspaceInvoice(
  input: WorkspaceInvoiceFinalizeInput,
  client?: SupabaseClient | null,
): Promise<WorkspaceInvoiceFinalizeResult> {
  /*
   * 01P4E1C1 — die Anfrage muss kanonisch sein, **bevor** sie den Server
   * erreicht: nicht leer und ohne führenden oder folgenden Whitespace. Es wird
   * nicht getrimmt und nicht normalisiert fortgesetzt — eine nichtkanonische
   * Eingabe ist ein lokaler Fehler (`validation`, nicht wiederholbar).
   */
  const canonicalInput = (value: unknown): boolean =>
    typeof value === 'string' && value.length > 0 && value.trim() === value;

  if (!canonicalInput(input.workspaceId)) {
    throw new WorkspaceInvoiceCloudError(
      'workspace_id fehlt oder ist nicht kanonisch',
      'validation',
      false,
    );
  }
  if (!canonicalInput(input.vorgangId)) {
    throw new WorkspaceInvoiceCloudError(
      'vorgang_id fehlt oder ist nicht kanonisch',
      'validation',
      false,
    );
  }
  if (!canonicalInput(input.clientInvoiceId)) {
    throw new WorkspaceInvoiceCloudError(
      'client_invoice_id fehlt oder ist nicht kanonisch',
      'validation',
      false,
    );
  }
  /*
   * Der lokale Beleg muss dieselbe Kennung tragen. Dass der Server die
   * Payload-ID ohnehin überschreibt, darf diesen lokalen Widerspruch nicht
   * verdecken — er wird hier abgewiesen, nicht repariert.
   */
  if (input.invoice.id !== input.clientInvoiceId) {
    throw new WorkspaceInvoiceCloudError(
      'invoice.id weicht von client_invoice_id ab',
      'validation',
      false,
    );
  }

  try {
    const supabase = getClient(client);
    const { data, error } = await supabase.rpc('finalize_workspace_invoice', {
      p_workspace_id: input.workspaceId,
      p_vorgang_id: input.vorgangId,
      p_client_invoice_id: input.clientInvoiceId,
      p_invoice: buildWorkspaceInvoiceFinalizePayload(input.invoice),
    });

    if (error) {
      throw classifyInvoiceCloudError(error);
    }

    /*
     * 01P4E1B/01P4E1E — die Antworthülle wird strikt geprüft, bevor irgendetwas
     * abgebildet wird: keine Coercion, keine Defaults für fehlende Felder.
     * Jede Abweichung ist eine ungültige Server-Antwort, kein Teilergebnis.
     */
    const { idempotentReplay, row } = readFinalizeEnvelope(data);
    const envelope = data as Record<string, unknown>;

    const invoicePayload = envelope.invoice;
    if (invoicePayload === undefined || invoicePayload === null) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung (invoice:missing).',
        'unknown',
        true,
      );
    }

    // 01P4D2B4 — dieselbe strukturelle Schutzgrenze wie beim Pull.
    const validated = validateWorkspaceInvoiceCloudPayload(invoicePayload);
    if (!validated.ok) {
      throw new WorkspaceInvoiceCloudError(
        `Ungültige Server-Antwort bei Rechnungsfinalisierung (${validated.detail}).`,
        'unknown',
        false,
      );
    }

    /*
     * 01P4E1C1 — die Antwortzeile durchläuft **denselben** strikten Vertrag wie
     * eine Pull-Zeile: kanonische Spaltentexte, Jahresgrenzen, Sequenz > 0,
     * reiner Payload, Strukturvalidierung und die fünf Spalten-/Payload-
     * Bindungen. Damit kann keine unvollständige Zeile mehr durchrutschen.
     */
    const parsedRow = parseWorkspaceInvoicePullRow(row);
    if (!parsedRow) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung (row:invalid).',
        'unknown',
        false,
      );
    }

    /*
     * 01P4E1C — Eingabe, kanonischer Invoice-Payload und zurückgegebene
     * Tabellenzeile werden exakt gegeneinander gebunden. Der SQL-Vertrag ist
     * in allen drei Rückgaben identisch: `'invoice', v_existing.payload` und
     * `'row', to_jsonb(v_existing)` — `data.invoice` **ist** `row.payload`.
     * Die Eingabe ist an dieser Stelle bereits als kanonisch geprüft; das SQL
     * speichert sie unverändert. Ein Widerspruch wird nie repariert.
     */
    const bindings: Array<[string, unknown, unknown]> = [
      ['row.workspace_id', parsedRow.workspace_id, input.workspaceId],
      ['row.vorgang_id', parsedRow.vorgang_id, input.vorgangId],
      ['row.client_invoice_id', parsedRow.client_invoice_id, input.clientInvoiceId],
      ['payload.id', validated.payload.id, input.clientInvoiceId],
      ['row.invoice_number', parsedRow.invoice_number, validated.payload.number],
      ['row.invoice_type', parsedRow.invoice_type, validated.payload.type],
      ['row.invoice_status', parsedRow.invoice_status, validated.payload.status],
    ];
    /*
     * Für diesen frischen Legacy-RPC ist die Sequenz Pflicht — anders als beim
     * normalen Pull, wo ein gültiger älterer Payload ohne dieses optionale Feld
     * erlaubt bleibt und die Zeilenspalte maßgeblich ist.
     */
    const payloadSequence = validated.payload.invoiceSequenceNumber;
    if (
      typeof payloadSequence !== 'number' ||
      !Number.isInteger(payloadSequence) ||
      payloadSequence <= 0
    ) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung (invoice.invoiceSequenceNumber:not_positive_integer).',
        'unknown',
        false,
      );
    }
    bindings.push([
      'row.invoice_sequence_number',
      parsedRow.invoice_sequence_number,
      payloadSequence,
    ]);

    for (const [path, actual, expected] of bindings) {
      if (actual !== expected) {
        throw new WorkspaceInvoiceCloudError(
          `Ungültige Server-Antwort bei Rechnungsfinalisierung (${path}:mismatch).`,
          'unknown',
          false,
        );
      }
    }

    /*
     * `row.payload` und `data.invoice` sind derselbe JSONB-Inhalt. Verglichen
     * wird **kanonisch** — eine abweichende Schlüsselreihenfolge ist kein
     * Unterschied, jede inhaltliche Abweichung schon.
     */
    if (canonicalJsonStringify(parsedRow.payload) !== canonicalJsonStringify(validated.payload)) {
      throw new WorkspaceInvoiceCloudError(
        'Ungültige Server-Antwort bei Rechnungsfinalisierung (row.payload:mismatch).',
        'unknown',
        false,
      );
    }

    // Erst jetzt — nach vollständiger Hüllen-, Payload- und Bindungsprüfung.
    // Die Rückgabewerte stammen ausschließlich aus der validierten Zeile.
    return {
      invoice: mapCloudPayloadToVorgangInvoice(validated.payload),
      idempotentReplay,
      rowVersion: parsedRow.row_version,
      cloudInvoiceId: parsedRow.id,
    };
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      throw error;
    }
    throw classifyInvoiceCloudError(
      error instanceof Error ? { message: error.message } : { message: 'Unbekannter Fehler' },
    );
  }
}
