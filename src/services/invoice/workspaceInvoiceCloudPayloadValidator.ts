/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B4 — strenge, reine
 * Strukturprüfung eines Cloud-Rechnungs-Payloads **vor** jeder Abbildung.
 *
 * Er nimmt an oder lehnt ab. Er normalisiert nichts, repariert nichts, trimmt
 * nichts und ersetzt nichts. Ein **fehlendes** optionales Feld bleibt erlaubt;
 * ein **vorhandenes** Feld mit falschem Typ macht den gesamten Payload
 * ungültig — es wird niemals gelöscht oder konvertiert.
 *
 * Autoritativ für `id`, `number`, `type`, `status` und die Sequenz bleiben die
 * Zeilenspalten des Pulls; hier wird nur geprüft, dass der Payload sie — falls
 * vorhanden — nicht in einer unbrauchbaren Form trägt.
 */
import { BRANDING_SNAPSHOT_VERSION } from '../../types/branding';
import { COMPANY_SNAPSHOT_KEYS } from './companySnapshotFieldCatalog';
import {
  CUSTOMER_SNAPSHOT_KEYS,
  isRequiredCustomerSnapshotKey,
} from './customerSnapshotFieldCatalog';
import {
  isLogoMimeType,
  isValidBrandingPrimaryColor,
} from '../branding/brandingSnapshotService';
import { isDocumentTemplateId } from '../../types/branding';

import type {
  InvoiceCalculationMode,
  InvoiceDocumentType,
  InvoicePaymentStatus,
  InvoiceSentVia,
  TaxStatus,
  VorgangInvoice,
} from '../../types/models';

export type WorkspaceInvoiceCloudPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; detail: string };

const INVOICE_KEYS = new Set([
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
  // SERVICE-PERIOD-01B — Approval-Faktum; fehlt bei Rechnungen von davor.
  'servicePeriodConfirmed',
  'paymentDueDate',
  'paymentTermsText',
  'skontoText',
  // E-RECHNUNG-04B — die eingefrorene Währung des Belegs.
  'currencyCode',
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
  // MANUAL-INVOICE-CUSTOMER-IDENTITY-01B — die stabile Kundenreferenz.
  'customerId',
  'archiveDocumentId',
  'payments',
  'paymentStatus',
  'cancelledAt',
  'cancelReason',
  'sentAt',
  'sentVia',
  'sentNote',
  'sentSource',
  'sentDeliveryId',
  'sentManualPrior',
  'expectedAmendmentSequence',
]);

const LINE_KEYS = new Set([
  'id',
  'orderPositionId',
  'description',
  'quantity',
  'unit',
  'unitLabel',
  'unitPrice',
  'lineTotal',
]);

/**
 * CUSTOMER-SNAPSHOT-FIELD-CATALOG-04B — derselbe Schlüsselvertrag wie im
 * Prepared-Finalize-Request-Validator, aus einer Quelle. Die Prüfregeln
 * bleiben hier.
 */
const CUSTOMER_KEYS = new Set<string>(CUSTOMER_SNAPSHOT_KEYS);

/**
 * COMPANY-SNAPSHOT-FIELD-CATALOG-01B — der Schlüsselvertrag kommt aus der
 * gemeinsamen Quelle, die Prüfregeln bleiben hier.
 *
 * Vorher stand hier eine eigene Liste, und im Finalize-Request-Validator eine
 * zweite mit demselben Inhalt. Beim Registerblock wurde nur eine davon
 * ergänzt — der Fehler fiel erst auf, als die Finalisierung eines
 * eingetragenen Betriebs abgewiesen wurde. Diese Möglichkeit gibt es nicht
 * mehr; alles andere an diesem Validator ist unverändert.
 */
const COMPANY_KEYS = new Set<string>(COMPANY_SNAPSHOT_KEYS);

/** BRANDING-01F-2 — geschlossener Vertrag, siehe `checkBrandingSnapshot`. */
const BRANDING_SNAPSHOT_KEYS = new Set(['version', 'logo', 'primaryColor', 'documentTemplate']);
const BRANDING_LOGO_KEYS = new Set(['assetId', 'mimeType']);

const DEDUCTION_KEYS = new Set([
  'invoiceId',
  'invoiceNumber',
  'abschlagNumber',
  'date',
  'subtotal',
  'amount',
]);

/*
 * 01P4E1B — keine Enum-Drift. Jede Laufzeitmenge wird aus einem exhaustiven
 * `Record<Union, true>` gebildet. Fehlt ein Wert der zentralen Union, meldet
 * TypeScript einen Fehler; ein erfundener oder vertippter Wert ebenfalls. Die
 * Modelltypen selbst bleiben unverändert, es entsteht keine neue Typdatei.
 */
function enumSet<T extends string>(values: Record<T, true>): ReadonlySet<string> {
  return new Set(Object.keys(values));
}

const INVOICE_TYPES = enumSet<InvoiceDocumentType>({
  rechnung: true,
  abschlag: true,
  teilrechnung: true,
  schluss: true,
  gutschrift: true,
  storno: true,
});

const INVOICE_STATUSES = enumSet<VorgangInvoice['status']>({
  entwurf: true,
  vorbereitet: true,
  versendet: true,
});

const TAX_STATUSES = enumSet<TaxStatus>({
  standard_19: true,
  standard_7: true,
  kleinunternehmer_19: true,
  reverse_charge_13b: true,
  tax_free: true,
  unclear: true,
});

const CALCULATION_MODES = enumSet<InvoiceCalculationMode>({
  quantity_based: true,
  fixed_amount: true,
});

const SENT_SOURCE = new Set(['manual', 'officepilot']);
const SENT_VIA = enumSet<InvoiceSentVia>({
  email: true,
  post: true,
  persoenlich: true,
  portal: true,
  sonstige: true,
});

/*
 * FINANZCORE-05C — `ueberbezahlt` gehoert dazu.
 *
 * Diese Liste entscheidet, ob eine Nutzlast ueberhaupt in die Cloud darf.
 * Ohne den neuen Wert waere eine ueberbezahlte Rechnung nicht mehr
 * uebertragbar gewesen — der Status ist zwar rein abgeleitet, reist aber im
 * Payload mit (der Server entfernt ihn erst danach).
 */
const PAYMENT_STATUSES = enumSet<InvoicePaymentStatus>({
  offen: true,
  teilbezahlt: true,
  bezahlt: true,
  ueberbezahlt: true,
  ueberfaellig: true,
  storniert: true,
});
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class CloudPayloadReject extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

function reject(detail: string): never {
  throw new CloudPayloadReject(detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) reject(`${path}:not_object`);
  return value;
}

function keysWithin(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) reject(`${path}.${key}:forbidden_key`);
    if (!allowed.has(key)) reject(`${path}.${key}:unknown_field`);
  }
}

function requiredText(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) reject(`${path}:not_text`);
}

/** Vorhanden ⇒ echter String (auch leer). Fehlend ⇒ erlaubt. `null` ⇒ ungültig. */
function optionalText(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string') reject(`${path}:not_text`);
}

function requiredFinite(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) reject(`${path}:not_finite`);
}

function optionalFinite(value: unknown, path: string): void {
  if (value === undefined) return;
  requiredFinite(value, path);
}

function optionalBoolean(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') reject(`${path}:not_boolean`);
}

function optionalEnum(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.has(value)) reject(`${path}:unknown_value`);
}

function checkLine(value: unknown, path: string): void {
  const line = object(value, path);
  keysWithin(line, LINE_KEYS, path);
  requiredText(line.id, `${path}.id`);
  /*
   * MANUAL-INVOICE-01B1 — siehe Finalize-Validator: Eine freie Zeile trägt
   * keinen Auftragsbezug. Abwesend ja, Leerstring nein.
   */
  if (line.orderPositionId !== undefined) {
    requiredText(line.orderPositionId, `${path}.orderPositionId`);
  }
  optionalText(line.description, `${path}.description`);
  if (typeof line.description !== 'string') reject(`${path}.description:not_text`);
  requiredFinite(line.quantity, `${path}.quantity`);
  requiredText(line.unit, `${path}.unit`);
  optionalText(line.unitLabel, `${path}.unitLabel`);
  requiredFinite(line.unitPrice, `${path}.unitPrice`);
  requiredFinite(line.lineTotal, `${path}.lineTotal`);
}

function checkCustomerSnapshot(value: unknown, path: string): void {
  if (value === undefined) return;
  const snapshot = object(value, path);
  keysWithin(snapshot, CUSTOMER_KEYS, path);
  for (const key of CUSTOMER_KEYS) {
    /*
     * E-RECHNUNG-04B — die neuen Felder sind optional, und zwar für immer.
     *
     * Ein Beleg von vor 04B trägt sie nicht; ihn deshalb abzuweisen hiesse,
     * gültige Bestandsrechnungen aus der Cloud unlesbar zu machen. Steht ein
     * Wert da, muss er ein Text sein — nur das wird geprüft.
     */
    if (snapshot[key] === undefined && !isRequiredCustomerSnapshotKey(key)) continue;
    if (typeof snapshot[key] !== 'string') reject(`${path}.${key}:not_text`);
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
    if (typeof snapshot[key] !== 'string') reject(`${path}.${key}:not_text`);
  }
  requiredFinite(snapshot.defaultPaymentDays, `${path}.defaultPaymentDays`);
  optionalText(snapshot.logoDataUrl, `${path}.logoDataUrl`);
  optionalBoolean(snapshot.skontoEnabled, `${path}.skontoEnabled`);
  optionalFinite(snapshot.skontoPercent, `${path}.skontoPercent`);
  optionalFinite(snapshot.skontoDays, `${path}.skontoDays`);
  optionalText(snapshot.managingDirector, `${path}.managingDirector`);
  // SETTINGS-01B1 — Kontoinhaber: optional, nur Text.
  optionalText(snapshot.accountHolder, `${path}.accountHolder`);
  /* 01I hatte die Schlüssel erlaubt, ihren Typ aber nicht geprüft. */
  optionalText(snapshot.registrationAuthority, `${path}.registrationAuthority`);
  optionalText(snapshot.registrationNumber, `${path}.registrationNumber`);
  optionalText(snapshot.taxFreeNotice, `${path}.taxFreeNotice`);
}

/**
 * BRANDING-01F-2 — der geschlossene Vertrag des eingefrorenen Brandings.
 *
 * Die Regeln stehen hier lokal, wie bei jedem anderen Teilvertrag dieses
 * Validators: Er darf sich nicht auf eine Builderfunktion stützen, die sich
 * später ändern kann. Die beiden **Wertregeln** — erlaubte MIME-Typen und
 * Farbform — kommen dagegen aus dem Branding-Vertrag selbst; sie zweimal zu
 * schreiben hiesse, sie irgendwann auseinanderlaufen zu lassen.
 *
 * Erlaubt sind ausschliesslich `version`, `logo` und `primaryColor`; im Logo
 * nur `assetId` und `mimeType`. Ein Speicherpfad, eine signierte URL oder
 * Bildbytes werden damit als `unknown_field` abgelehnt, statt stillschweigend
 * mitzureisen.
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
    requiredText(logo.assetId, `${path}.logo.assetId`);
    if (typeof logo.assetId === 'string' && logo.assetId.trim().length === 0) {
      reject(`${path}.logo.assetId:not_text`);
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

  // SETTINGS-01B1 — nur implementierte Vorlagen; fehlend = classic.
  if (snapshot.documentTemplate !== undefined && !isDocumentTemplateId(snapshot.documentTemplate)) {
    reject(`${path}.documentTemplate:invalid`);
  }
}

function checkDeduction(value: unknown, path: string): void {
  const deduction = object(value, path);
  keysWithin(deduction, DEDUCTION_KEYS, path);
  requiredText(deduction.invoiceId, `${path}.invoiceId`);
  if (typeof deduction.invoiceNumber !== 'string') reject(`${path}.invoiceNumber:not_text`);
  optionalFinite(deduction.abschlagNumber, `${path}.abschlagNumber`);
  requiredText(deduction.date, `${path}.date`);
  requiredFinite(deduction.subtotal, `${path}.subtotal`);
  requiredFinite(deduction.amount, `${path}.amount`);
}

export function validateWorkspaceInvoiceCloudPayload(
  payload: unknown,
): WorkspaceInvoiceCloudPayloadResult {
  try {
    const value = object(payload, 'payload');
    keysWithin(value, INVOICE_KEYS, 'payload');

    /* Tatsächlich verwendete Pflichtfelder. */
    requiredText(value.id, 'payload.id');
    if (typeof value.number !== 'string') reject('payload.number:not_text');
    const type = value.type;
    if (typeof type !== 'string' || !INVOICE_TYPES.has(type)) reject('payload.type:unknown_value');
    if (typeof value.status !== 'string' || !INVOICE_STATUSES.has(value.status)) {
      reject('payload.status:unknown_value');
    }
    requiredText(value.date, 'payload.date');
    requiredText(value.createdAt, 'payload.createdAt');
    requiredFinite(value.subtotal, 'payload.subtotal');
    requiredFinite(value.amount, 'payload.amount');
    if (typeof value.taxStatus !== 'string' || !TAX_STATUSES.has(value.taxStatus)) {
      reject('payload.taxStatus:unknown_value');
    }
    if (!Array.isArray(value.positions)) reject('payload.positions:not_array');
    value.positions.forEach((line, index) => checkLine(line, `payload.positions[${index}]`));

    /* Optionale Felder: fehlend erlaubt, vorhanden streng. */
    optionalFinite(value.abschlagNumber, 'payload.abschlagNumber');
    optionalFinite(value.invoiceSequenceNumber, 'payload.invoiceSequenceNumber');
    optionalEnum(value.calculationMode, CALCULATION_MODES, 'payload.calculationMode');
    optionalFinite(value.fixedAmountNet, 'payload.fixedAmountNet');
    optionalText(value.issueDate, 'payload.issueDate');
    optionalText(value.servicePeriodFrom, 'payload.servicePeriodFrom');
    optionalText(value.servicePeriodTo, 'payload.servicePeriodTo');
    optionalBoolean(value.servicePeriodConfirmed, 'payload.servicePeriodConfirmed');
    optionalText(value.paymentDueDate, 'payload.paymentDueDate');
    optionalText(value.paymentTermsText, 'payload.paymentTermsText');
    optionalText(value.skontoText, 'payload.skontoText');
    optionalText(value.introText, 'payload.introText');
    optionalText(value.closingText, 'payload.closingText');
    optionalText(value.baustelle, 'payload.baustelle');
    optionalText(value.vorgangTitle, 'payload.vorgangTitle');
    // 01B — abwesend gültig; vorhanden nur als nichtleerer kanonischer String.
    if (value.customerId !== undefined) {
      requiredText(value.customerId, 'payload.customerId');
      const customerId = value.customerId as string;
      if (customerId.trim() !== customerId || customerId.trim().length === 0) {
        reject('payload.customerId:not_canonical');
      }
    }
    optionalText(value.archiveDocumentId, 'payload.archiveDocumentId');
    optionalText(value.cancelledAt, 'payload.cancelledAt');
    optionalText(value.cancelReason, 'payload.cancelReason');
    optionalText(value.sentAt, 'payload.sentAt');
    optionalText(value.sentNote, 'payload.sentNote');
    optionalEnum(value.sentVia, SENT_VIA, 'payload.sentVia');
    optionalEnum(value.sentSource, SENT_SOURCE, 'payload.sentSource');
    optionalText(value.sentDeliveryId, 'payload.sentDeliveryId');
    // EMAIL-01B2 — die vor einem OfficePilot-Versand manuell erfassten Angaben bleiben erhalten.
    if (value.sentManualPrior !== undefined) {
      const prior = object(value.sentManualPrior, 'payload.sentManualPrior');
      optionalText(prior.sentAt, 'payload.sentManualPrior.sentAt');
      optionalEnum(prior.sentVia, SENT_VIA, 'payload.sentManualPrior.sentVia');
      optionalText(prior.sentNote, 'payload.sentManualPrior.sentNote');
    }
    optionalEnum(value.paymentStatus, PAYMENT_STATUSES, 'payload.paymentStatus');
    if (value.payments !== undefined && !Array.isArray(value.payments)) {
      reject('payload.payments:not_array');
    }

    if (value.legalNotices !== undefined) {
      if (!Array.isArray(value.legalNotices)) reject('payload.legalNotices:not_array');
      value.legalNotices.forEach((notice, index) => {
        if (typeof notice !== 'string') reject(`payload.legalNotices[${index}]:not_text`);
      });
    }
    if (value.previousAbschlagDeductions !== undefined) {
      if (!Array.isArray(value.previousAbschlagDeductions)) {
        reject('payload.previousAbschlagDeductions:not_array');
      }
      value.previousAbschlagDeductions.forEach((entry, index) =>
        checkDeduction(entry, `payload.previousAbschlagDeductions[${index}]`),
      );
    }
    checkCustomerSnapshot(value.customerSnapshot, 'payload.customerSnapshot');
    checkCompanySnapshot(value.companySnapshot, 'payload.companySnapshot');
    checkBrandingSnapshot(value.brandingSnapshot, 'payload.brandingSnapshot');

    /*
     * READER-AMENDMENT-OPTIONAL-01 — `expectedAmendmentSequence` ist ein
     * Finalisierungs-Guard, keine Rechnungseigenschaft.
     *
     * Der Client sendet ihn bei einer Schlussrechnung zwingend,
     * `finalize_workspace_invoice` prüft ihn gegen den tatsächlichen
     * Nachtragsstand — und `normalize_workspace_invoice_payload_for_idempotency`
     * entfernt ihn danach ausdrücklich wieder:
     *
     *   -- Strip RPC meta fields that must never become stored invoice content.
     *
     * Eine servergespeicherte Schlussrechnung trägt ihn deshalb **nie**. Als
     * Pflichtfeld gelesen war jede Schlussrechnung originübergreifend
     * unlesbar — daran ist die reale Rechnung 2026-0003 gescheitert.
     *
     * Fehlend ist damit gültig. **Vorhanden bleibt streng**: Ein Wert, den
     * jemand mitschickt, muss eine echte Folge sein. Es wird nichts
     * normalisiert, nichts umgewandelt und kein Standardwert erfunden.
     */
    const amendment = value.expectedAmendmentSequence;
    if (type === 'schluss') {
      if (amendment !== undefined && (!Number.isInteger(amendment) || (amendment as number) < 0)) {
        reject('payload.expectedAmendmentSequence:not_sequence');
      }
    } else if (amendment !== undefined) {
      reject('payload.expectedAmendmentSequence:not_allowed');
    }

    return { ok: true, payload: value };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof CloudPayloadReject ? error.detail : 'invalid',
    };
  }
}
