/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4B — strenger, reiner
 * Laufzeitvalidator des vorbereiteten Cloud-Requests.
 *
 * Er nimmt an oder lehnt ab. Er ergänzt nichts, entfernt nichts, trimmt
 * nichts, benennt nichts um, normalisiert nichts und baut nichts neu.
 *
 * Die Feld-Whitelisten gehören zu **Request-Formatversion 1**. Eine spätere
 * Modellerweiterung verlangt eine bewusste neue Request-Version — unbekannte
 * Daten werden niemals still in die Cloud gesendet.
 */
import type { TaxStatus, VorgangInvoice } from '../../types/models';
import {
  canonicalJsonStringify,
  isPlainJsonObject,
  FORBIDDEN_OBJECT_KEYS,
} from './invoicePreparedResponseProjection';
import { BRANDING_SNAPSHOT_VERSION } from '../../types/branding';
import {
  isLogoMimeType,
  isValidBrandingPrimaryColor,
} from '../branding/brandingSnapshotService';

export const PREPARED_FINALIZE_REQUEST_KIND =
  'officepilot-workspace-invoice-finalize-request' as const;
/*
 * 01P4E3D — von 1 auf 2 erhöht. 01P4E3B hat die **Bedeutung** von
 * `expectedResponseProjectionRawJson` geändert: die Projektion entfernt seither
 * dieselben zehn Metaschlüssel wie die aktive SQL-Normalisierung, darunter
 * `expectedAmendmentSequence`. Ein mit Version 1 gespeicherter Request trägt
 * eine Projektion nach altem Vertrag und wird deshalb abgewiesen statt
 * umgeschrieben — es gibt keinen dualen Leser.
 *
 * Der **äußere** Vorbereitungsumschlag ist davon unberührt: seine Struktur hat
 * sich nicht geändert, `INVOICE_DRAFT_PREPARATION_FORMAT_VERSION` bleibt 1.
 */
/*
 * BRANDING-01F-2 — von 2 auf 3 erhöht.
 *
 * Der Kopf dieser Datei bindet die Feld-Whitelisten ausdrücklich an die
 * Request-Formatversion: „Eine spätere Modellerweiterung verlangt eine bewusste
 * neue Request-Version." `brandingSnapshot` ist genau eine solche Erweiterung —
 * die Whitelist eines Version-3-Requests akzeptiert ein Feld, das ein
 * Version-2-Leser abgelehnt hätte.
 *
 * Wie bei 01P4E3D gibt es **keinen dualen Leser**: Ein mit Version 2
 * gespeicherter Request wird abgewiesen, nicht umgeschrieben. Er ist inhaltlich
 * unschädlich — ihm fehlt lediglich das neue optionale Feld —, aber ein
 * stillschweigend akzeptierter Fremdversions-Request wäre der Anfang genau der
 * Unschärfe, die dieser Vertrag verhindern soll.
 */
export const PREPARED_FINALIZE_REQUEST_FORMAT_VERSION = 3 as const;

export const INVOICE_APPROVAL_CONTEXT_KIND = 'officepilot-invoice-approval-context' as const;
export const INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION = 1 as const;

export interface PreparedWorkspaceInvoiceFinalizeRequest {
  kind: typeof PREPARED_FINALIZE_REQUEST_KIND;
  formatVersion: typeof PREPARED_FINALIZE_REQUEST_FORMAT_VERSION;
  workspaceId: string;
  vorgangId: string;
  clientInvoiceId: string;
  invoice: VorgangInvoice;
  invoicePayload: Record<string, unknown>;
  expectedResponseProjectionRawJson: string;
}

export interface InvoiceApprovalContextV1 {
  kind: typeof INVOICE_APPROVAL_CONTEXT_KIND;
  formatVersion: typeof INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION;
  reverseCharge13bConfirmed: boolean;
  overbillingRequired: boolean;
  overbillingAcknowledged: boolean;
  overbillingEvidenceKeys: string[];
  archiveCompanyName: string;
}

export type ValidatePreparedRequestResult =
  | { ok: true; request: PreparedWorkspaceInvoiceFinalizeRequest }
  | { ok: false; detail: string };

export type ValidateApprovalContextResult =
  | { ok: true; approvalContext: InvoiceApprovalContextV1 }
  | { ok: false; detail: string };

/* -------------------------------------------------------------------------- */
/* Whitelisten der Formatversion 1                                            */
/* -------------------------------------------------------------------------- */

const REQUEST_KEYS = [
  'kind',
  'formatVersion',
  'workspaceId',
  'vorgangId',
  'clientInvoiceId',
  'invoice',
  'invoicePayload',
  'expectedResponseProjectionRawJson',
] as const;

const INVOICE_KEYS = [
  'id',
  'number',
  'type',
  'abschlagNumber',
  'invoiceSequenceNumber',
  'positions',
  'calculationMode',
  'fixedAmountNet',
  'subtotal',
  'taxStatus',
  'amount',
  'status',
  'date',
  'createdAt',
  'issueDate',
  'servicePeriodFrom',
  'servicePeriodTo',
  'paymentDueDate',
  'paymentTermsText',
  'skontoText',
  'customerSnapshot',
  'companySnapshot',
  // BRANDING-01F-2 — das eingefrorene Branding dieser Rechnung.
  'brandingSnapshot',
  'legalNotices',
  'previousAbschlagDeductions',
  'introText',
  'closingText',
  'baustelle',
  'vorgangTitle',
  'archiveDocumentId',
  'payments',
  'paymentStatus',
  'cancelledAt',
  'cancelReason',
  'sentAt',
  'sentVia',
  'sentNote',
  'expectedAmendmentSequence',
] as const;

/** Der Payload trägt niemals Zahlungs- oder Archivdaten. */
const PAYLOAD_FORBIDDEN_KEYS = new Set<string>([
  'payments',
  'paymentStatus',
  'archiveDocumentId',
  'expected_amendment_sequence',
]);

const LINE_KEYS = [
  'id',
  'orderPositionId',
  'description',
  'quantity',
  'unit',
  'unitLabel',
  'unitPrice',
  'lineTotal',
] as const;

const CUSTOMER_KEYS = [
  'name',
  'contactPerson',
  'street',
  'zip',
  'city',
  'email',
  'phone',
] as const;

const COMPANY_KEYS = [
  'companyName',
  'legalForm',
  'logoDataUrl',
  'street',
  'zip',
  'city',
  'country',
  'contactPerson',
  'phone',
  'email',
  'website',
  'taxNumber',
  'vatId',
  'bankName',
  'iban',
  'bic',
  'defaultPaymentDays',
  'defaultPaymentTerms',
  'defaultSkonto',
  'skontoEnabled',
  'skontoPercent',
  'skontoDays',
  'managingDirector',
  'taxFreeNotice',
  'invoiceFooterNotes',
] as const;

/** BRANDING-01F-2 — geschlossener Vertrag, siehe `checkBrandingSnapshot`. */
const BRANDING_SNAPSHOT_KEYS = ['version', 'logo', 'primaryColor'] as const;
const BRANDING_LOGO_KEYS = ['assetId', 'mimeType'] as const;

const DEDUCTION_KEYS = [
  'invoiceId',
  'invoiceNumber',
  'abschlagNumber',
  'date',
  'subtotal',
  'amount',
] as const;

const INVOICE_TYPES = new Set([
  'rechnung',
  'abschlag',
  'teilrechnung',
  'schluss',
  'gutschrift',
  'storno',
]);

const TAX_STATUSES = new Set([
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
]);

/** Genau die Aufzählung `OrderUnit` aus models.ts — keine stille Erweiterung. */
const ORDER_UNITS = new Set(['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal']);

const CALCULATION_MODES = new Set(['quantity_based', 'fixed_amount']);
const SENT_VIA = new Set(['email', 'post', 'persoenlich', 'portal', 'sonstige']);
const PAYMENT_STATUSES = new Set(['offen', 'teilbezahlt', 'bezahlt', 'ueberfaellig', 'storniert']);
const FORBIDDEN = new Set<string>(FORBIDDEN_OBJECT_KEYS);

/* -------------------------------------------------------------------------- */
/* Prädikate                                                                  */
/* -------------------------------------------------------------------------- */

class Reject extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

function reject(detail: string): never {
  throw new Reject(detail);
}

function keysWithin(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const permitted = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) reject(`${path}.${key}:forbidden_key`);
    if (!permitted.has(key)) reject(`${path}.${key}:unknown_field`);
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainJsonObject(value)) reject(`${path}:not_object`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) reject(`${path}:not_string`);
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string') reject(`${path}:not_string`);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) reject(`${path}:not_finite`);
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): void {
  if (value === undefined) return;
  finiteNumber(value, path);
}

function optionalBoolean(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') reject(`${path}:not_boolean`);
}

function enumValue(value: unknown, allowed: Set<string>, path: string): string {
  const text = requiredString(value, path);
  if (!allowed.has(text)) reject(`${path}:unknown_value`);
  return text;
}

function optionalEnum(value: unknown, allowed: Set<string>, path: string): void {
  if (value === undefined) return;
  enumValue(value, allowed, path);
}

function checkLine(value: unknown, path: string): void {
  const line = object(value, path);
  keysWithin(line, LINE_KEYS, path);
  requiredString(line.id, `${path}.id`);
  requiredString(line.orderPositionId, `${path}.orderPositionId`);
  if (typeof line.description !== 'string') reject(`${path}.description:not_string`);
  finiteNumber(line.quantity, `${path}.quantity`);
  enumValue(line.unit, ORDER_UNITS, `${path}.unit`);
  optionalString(line.unitLabel, `${path}.unitLabel`);
  finiteNumber(line.unitPrice, `${path}.unitPrice`);
  finiteNumber(line.lineTotal, `${path}.lineTotal`);
}

function checkCustomerSnapshot(value: unknown, path: string): void {
  if (value === undefined) return;
  const snapshot = object(value, path);
  keysWithin(snapshot, CUSTOMER_KEYS, path);
  for (const key of CUSTOMER_KEYS) {
    if (typeof snapshot[key] !== 'string') reject(`${path}.${key}:not_string`);
  }
}

/**
 * BRANDING-01F-2 — geschlossener Vertrag des eingefrorenen Brandings.
 *
 * Wie jeder Teilvertrag dieses Validators bewusst lokal formuliert: Er darf
 * sich nie auf eine Builderfunktion stützen. Nur die beiden **Wertregeln**
 * — erlaubte MIME-Typen und Farbform — stammen aus dem Branding-Vertrag, damit
 * es sie genau einmal gibt.
 */
function checkBrandingSnapshot(value: unknown, path: string): void {
  if (value === undefined) return;
  const snapshot = object(value, path);
  keysWithin(snapshot, BRANDING_SNAPSHOT_KEYS, path);

  if (snapshot.version !== BRANDING_SNAPSHOT_VERSION) {
    reject(`${path}.version:unsupported`);
  }

  if (snapshot.logo !== undefined) {
    const logo = object(snapshot.logo, `${path}.logo`);
    keysWithin(logo, BRANDING_LOGO_KEYS, `${path}.logo`);
    if (typeof logo.assetId !== 'string' || logo.assetId.trim().length === 0) {
      reject(`${path}.logo.assetId:not_string`);
    }
    if (typeof logo.mimeType !== 'string' || !isLogoMimeType(logo.mimeType)) {
      reject(`${path}.logo.mimeType:unsupported`);
    }
  }

  if (snapshot.primaryColor !== undefined) {
    if (
      typeof snapshot.primaryColor !== 'string' ||
      !isValidBrandingPrimaryColor(snapshot.primaryColor)
    ) {
      reject(`${path}.primaryColor:invalid`);
    }
  }
}

function checkCompanySnapshot(value: unknown, path: string): void {
  if (value === undefined) return;
  const snapshot = object(value, path);
  keysWithin(snapshot, COMPANY_KEYS, path);
  for (const key of [
    'companyName',
    'legalForm',
    'street',
    'zip',
    'city',
    'country',
    'contactPerson',
    'phone',
    'email',
    'website',
    'taxNumber',
    'vatId',
    'bankName',
    'iban',
    'bic',
    'defaultPaymentTerms',
    'defaultSkonto',
    'invoiceFooterNotes',
  ]) {
    if (typeof snapshot[key] !== 'string') reject(`${path}.${key}:not_string`);
  }
  finiteNumber(snapshot.defaultPaymentDays, `${path}.defaultPaymentDays`);
  optionalString(snapshot.logoDataUrl, `${path}.logoDataUrl`);
  optionalBoolean(snapshot.skontoEnabled, `${path}.skontoEnabled`);
  optionalFiniteNumber(snapshot.skontoPercent, `${path}.skontoPercent`);
  optionalFiniteNumber(snapshot.skontoDays, `${path}.skontoDays`);
  optionalString(snapshot.managingDirector, `${path}.managingDirector`);
  optionalString(snapshot.taxFreeNotice, `${path}.taxFreeNotice`);
}

function checkDeduction(value: unknown, path: string): void {
  const deduction = object(value, path);
  keysWithin(deduction, DEDUCTION_KEYS, path);
  requiredString(deduction.invoiceId, `${path}.invoiceId`);
  if (typeof deduction.invoiceNumber !== 'string') reject(`${path}.invoiceNumber:not_string`);
  optionalFiniteNumber(deduction.abschlagNumber, `${path}.abschlagNumber`);
  requiredString(deduction.date, `${path}.date`);
  finiteNumber(deduction.subtotal, `${path}.subtotal`);
  finiteNumber(deduction.amount, `${path}.amount`);
}

/** Gemeinsamer Rumpf für `invoice` und `invoicePayload`. */
function checkInvoiceShape(
  value: unknown,
  clientInvoiceId: string,
  path: string,
  variant: 'invoice' | 'payload',
): Record<string, unknown> {
  const invoice = object(value, path);
  keysWithin(invoice, INVOICE_KEYS, path);
  if (variant === 'payload') {
    for (const key of Object.keys(invoice)) {
      if (PAYLOAD_FORBIDDEN_KEYS.has(key)) reject(`${path}.${key}:not_allowed_in_payload`);
    }
  }

  if (requiredString(invoice.id, `${path}.id`) !== clientInvoiceId) {
    reject(`${path}.id:client_invoice_id_mismatch`);
  }
  const type = enumValue(invoice.type, INVOICE_TYPES, `${path}.type`);
  if (invoice.status !== 'vorbereitet') reject(`${path}.status:not_vorbereitet`);
  if (typeof invoice.number !== 'string') reject(`${path}.number:not_string`);

  const positions = invoice.positions;
  if (!Array.isArray(positions)) reject(`${path}.positions:not_array`);
  positions.forEach((line, index) => checkLine(line, `${path}.positions[${index}]`));

  optionalFiniteNumber(invoice.abschlagNumber, `${path}.abschlagNumber`);
  optionalFiniteNumber(invoice.invoiceSequenceNumber, `${path}.invoiceSequenceNumber`);
  optionalEnum(invoice.calculationMode, CALCULATION_MODES, `${path}.calculationMode`);
  optionalFiniteNumber(invoice.fixedAmountNet, `${path}.fixedAmountNet`);
  finiteNumber(invoice.subtotal, `${path}.subtotal`);
  finiteNumber(invoice.amount, `${path}.amount`);
  enumValue(invoice.taxStatus, TAX_STATUSES, `${path}.taxStatus`);
  requiredString(invoice.date, `${path}.date`);
  requiredString(invoice.createdAt, `${path}.createdAt`);
  optionalString(invoice.issueDate, `${path}.issueDate`);
  optionalString(invoice.servicePeriodFrom, `${path}.servicePeriodFrom`);
  optionalString(invoice.servicePeriodTo, `${path}.servicePeriodTo`);
  optionalString(invoice.paymentDueDate, `${path}.paymentDueDate`);
  optionalString(invoice.paymentTermsText, `${path}.paymentTermsText`);
  optionalString(invoice.skontoText, `${path}.skontoText`);
  optionalString(invoice.introText, `${path}.introText`);
  optionalString(invoice.closingText, `${path}.closingText`);
  optionalString(invoice.baustelle, `${path}.baustelle`);
  optionalString(invoice.vorgangTitle, `${path}.vorgangTitle`);
  optionalString(invoice.cancelledAt, `${path}.cancelledAt`);
  optionalString(invoice.cancelReason, `${path}.cancelReason`);
  optionalString(invoice.sentAt, `${path}.sentAt`);
  optionalString(invoice.sentNote, `${path}.sentNote`);
  optionalEnum(invoice.sentVia, SENT_VIA, `${path}.sentVia`);

  if (invoice.legalNotices !== undefined) {
    if (!Array.isArray(invoice.legalNotices)) reject(`${path}.legalNotices:not_array`);
    invoice.legalNotices.forEach((notice, index) => {
      if (typeof notice !== 'string') reject(`${path}.legalNotices[${index}]:not_string`);
    });
  }
  if (invoice.previousAbschlagDeductions !== undefined) {
    if (!Array.isArray(invoice.previousAbschlagDeductions)) {
      reject(`${path}.previousAbschlagDeductions:not_array`);
    }
    invoice.previousAbschlagDeductions.forEach((entry, index) =>
      checkDeduction(entry, `${path}.previousAbschlagDeductions[${index}]`),
    );
  }
  checkCustomerSnapshot(invoice.customerSnapshot, `${path}.customerSnapshot`);
  checkCompanySnapshot(invoice.companySnapshot, `${path}.companySnapshot`);
  checkBrandingSnapshot(invoice.brandingSnapshot, `${path}.brandingSnapshot`);

  if (variant === 'invoice') {
    optionalString(invoice.archiveDocumentId, `${path}.archiveDocumentId`);
    if (invoice.payments !== undefined && !Array.isArray(invoice.payments)) {
      reject(`${path}.payments:not_array`);
    }
    optionalEnum(invoice.paymentStatus, PAYMENT_STATUSES, `${path}.paymentStatus`);
  }

  const amendment = invoice.expectedAmendmentSequence;
  if (type === 'schluss') {
    if (variant === 'payload' && amendment === undefined) {
      reject(`${path}.expectedAmendmentSequence:missing`);
    }
    if (amendment !== undefined) {
      if (!Number.isInteger(amendment) || (amendment as number) < 0) {
        reject(`${path}.expectedAmendmentSequence:not_sequence`);
      }
    }
  } else if (amendment !== undefined) {
    reject(`${path}.expectedAmendmentSequence:not_allowed`);
  }

  return invoice;
}

/* -------------------------------------------------------------------------- */
/* Festgeschriebene Version-1-Abbildung invoice → invoicePayload              */
/* -------------------------------------------------------------------------- */

/**
 * Hält das Verhalten von `buildWorkspaceInvoiceFinalizePayload` für
 * Request-Formatversion 1 fest. Der Validator darf sich niemals auf die
 * möglicherweise später geänderte Builder-Funktion stützen; laufen beide
 * auseinander, ist eine neue Request-Version einzuführen.
 */
export function buildInvoicePayloadV1(invoice: unknown): Record<string, unknown> | null {
  if (!isPlainJsonObject(invoice)) return null;
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(invoice)) {
    if (FORBIDDEN.has(key)) return null;
    if (key === 'payments' || key === 'paymentStatus' || key === 'archiveDocumentId') continue;
    if (key === 'expected_amendment_sequence') return null;
    if (key === 'expectedAmendmentSequence') continue;
    const value = invoice[key];
    if (value === undefined) continue;
    payload[key] = value;
  }

  if (isPlainJsonObject(invoice.companySnapshot)) {
    const company: Record<string, unknown> = {};
    for (const key of Object.keys(invoice.companySnapshot)) {
      if (FORBIDDEN.has(key)) return null;
      if (key === 'logoDataUrl') continue;
      // BRANDING-01E-1: `branding` bleibt bis 01F aus dem Rechnungsvertrag.
      if (key === 'branding') continue;
      const value = (invoice.companySnapshot as Record<string, unknown>)[key];
      if (value === undefined) continue;
      company[key] = value;
    }
    payload.companySnapshot = company;
  }

  if (invoice.type === 'schluss') {
    const amendment = invoice.expectedAmendmentSequence;
    payload.expectedAmendmentSequence = typeof amendment === 'number' ? amendment : 0;
  }

  return payload;
}

/* -------------------------------------------------------------------------- */
/* Öffentliche Prüfungen                                                      */
/* -------------------------------------------------------------------------- */

export function validatePreparedWorkspaceInvoiceFinalizeRequest(
  value: unknown,
): ValidatePreparedRequestResult {
  try {
    const request = object(value, 'request');
    keysWithin(request, REQUEST_KEYS, 'request');

    if (request.kind !== PREPARED_FINALIZE_REQUEST_KIND) reject('request.kind:unknown');
    if (request.formatVersion !== PREPARED_FINALIZE_REQUEST_FORMAT_VERSION) {
      reject('request.formatVersion:unsupported');
    }
    requiredString(request.workspaceId, 'request.workspaceId');
    requiredString(request.vorgangId, 'request.vorgangId');
    const clientInvoiceId = requiredString(request.clientInvoiceId, 'request.clientInvoiceId');
    requiredString(
      request.expectedResponseProjectionRawJson,
      'request.expectedResponseProjectionRawJson',
    );

    const invoice = checkInvoiceShape(request.invoice, clientInvoiceId, 'request.invoice', 'invoice');
    const payload = checkInvoiceShape(
      request.invoicePayload,
      clientInvoiceId,
      'request.invoicePayload',
      'payload',
    );

    // Der Payload muss exakt der festgeschriebenen Version-1-Abbildung entsprechen.
    const expected = buildInvoicePayloadV1(invoice);
    if (!expected) reject('request.invoicePayload:v1_build_failed');
    const expectedCanonical = canonicalJsonStringify(expected);
    const actualCanonical = canonicalJsonStringify(payload);
    if (expectedCanonical === null || actualCanonical === null) {
      reject('request.invoicePayload:not_canonical');
    }
    if (expectedCanonical !== actualCanonical) reject('request.invoicePayload:v1_mismatch');

    return { ok: true, request: request as unknown as PreparedWorkspaceInvoiceFinalizeRequest };
  } catch (error) {
    return { ok: false, detail: error instanceof Reject ? error.detail : 'invalid' };
  }
}

const APPROVAL_KEYS = [
  'kind',
  'formatVersion',
  'reverseCharge13bConfirmed',
  'overbillingRequired',
  'overbillingAcknowledged',
  'overbillingEvidenceKeys',
  'archiveCompanyName',
] as const;

export function validateInvoiceApprovalContext(
  value: unknown,
  binding: { taxStatus: TaxStatus },
): ValidateApprovalContextResult {
  try {
    const context = object(value, 'approvalContext');
    keysWithin(context, APPROVAL_KEYS, 'approvalContext');

    if (context.kind !== INVOICE_APPROVAL_CONTEXT_KIND) reject('approvalContext.kind:unknown');
    if (context.formatVersion !== INVOICE_APPROVAL_CONTEXT_FORMAT_VERSION) {
      reject('approvalContext.formatVersion:unsupported');
    }
    for (const key of [
      'reverseCharge13bConfirmed',
      'overbillingRequired',
      'overbillingAcknowledged',
    ]) {
      if (typeof context[key] !== 'boolean') reject(`approvalContext.${key}:not_boolean`);
    }
    const archiveCompanyName = requiredString(
      context.archiveCompanyName,
      'approvalContext.archiveCompanyName',
    );
    if (archiveCompanyName.trim().length === 0) {
      reject('approvalContext.archiveCompanyName:empty');
    }

    const evidence = context.overbillingEvidenceKeys;
    if (!Array.isArray(evidence)) reject('approvalContext.overbillingEvidenceKeys:not_array');
    const seen = new Set<string>();
    evidence.forEach((entry, index) => {
      const key = `approvalContext.overbillingEvidenceKeys[${index}]`;
      const text = requiredString(entry, key);
      if (text.trim().length === 0) reject(`${key}:empty`);
      if (seen.has(text)) reject(`${key}:duplicate`);
      seen.add(text);
    });

    if (context.overbillingRequired === false) {
      if (context.overbillingAcknowledged !== false) {
        reject('approvalContext.overbillingAcknowledged:not_required');
      }
      if (evidence.length > 0) reject('approvalContext.overbillingEvidenceKeys:not_required');
    } else {
      if (context.overbillingAcknowledged !== true) {
        reject('approvalContext.overbillingAcknowledged:missing');
      }
      if (evidence.length === 0) reject('approvalContext.overbillingEvidenceKeys:missing');
    }

    if (binding.taxStatus === 'reverse_charge_13b' && context.reverseCharge13bConfirmed !== true) {
      reject('approvalContext.reverseCharge13bConfirmed:missing');
    }

    return { ok: true, approvalContext: context as unknown as InvoiceApprovalContextV1 };
  } catch (error) {
    return { ok: false, detail: error instanceof Reject ? error.detail : 'invalid' };
  }
}
