import { getVorgangInvoice, updateInvoiceSentFields } from './vorgangService';
import type { InvoiceSentVia, VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

export const INVOICE_SENT_VIA_OPTIONS: readonly InvoiceSentVia[] = [
  'email',
  'post',
  'persoenlich',
  'portal',
  'sonstige',
] as const;

export interface InvoiceSentInput {
  sentAt: string;
  sentVia: InvoiceSentVia;
  sentNote?: string;
}

export type InvoiceSentMutationResult =
  | { ok: true; invoice: VorgangInvoice }
  | {
      ok: false;
      reason:
        | 'invoice_missing'
        | 'not_prepared'
        | 'already_sent'
        | 'not_sent'
        | 'invalid_date'
        | 'invalid_via'
        | 'update_failed'
        /** INVOICE-SENT-PERSIST-01C — im Speicher geändert, aber nicht dauerhaft. */
        | 'persist_failed';
    };

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const time = Date.parse(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(time);
}

export function isValidInvoiceSentVia(value: unknown): value is InvoiceSentVia {
  return (
    typeof value === 'string' &&
    (INVOICE_SENT_VIA_OPTIONS as readonly string[]).includes(value)
  );
}

function parseSentInput(
  input: InvoiceSentInput,
): { ok: true; value: InvoiceSentInput } | { ok: false; reason: 'invalid_date' | 'invalid_via' } {
  const sentAt = input.sentAt?.trim() ?? '';
  if (!sentAt || !isIsoDate(sentAt)) {
    return { ok: false, reason: 'invalid_date' };
  }
  if (!isValidInvoiceSentVia(input.sentVia)) {
    return { ok: false, reason: 'invalid_via' };
  }
  return {
    ok: true,
    value: {
      sentAt,
      sentVia: input.sentVia,
      sentNote: input.sentNote?.trim() || undefined,
    },
  };
}

/**
 * Mark a prepared invoice as sent. Does not send email/post — records user confirmation only.
 * Never called by PDF generation.
 */
export function markInvoiceAsSent(
  vorgangId: string,
  invoiceId: string,
  input: InvoiceSentInput,
): InvoiceSentMutationResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { ok: false, reason: 'invoice_missing' };
  }
  if (invoice.status === 'entwurf') {
    return { ok: false, reason: 'not_prepared' };
  }
  if (invoice.status === 'versendet') {
    return { ok: false, reason: 'already_sent' };
  }
  if (invoice.status !== 'vorbereitet') {
    return { ok: false, reason: 'not_prepared' };
  }

  const parsed = parseSentInput(input);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  const updated = updateInvoiceSentFields(vorgangId, invoiceId, {
    status: 'versendet',
    sentAt: parsed.value.sentAt,
    sentVia: parsed.value.sentVia,
    sentNote: parsed.value.sentNote,
  });
  if (!updated.ok) {
    return { ok: false, reason: updated.reason === 'persist_failed' ? 'persist_failed' : 'update_failed' };
  }
  return { ok: true, invoice: updated.invoice };
}

/**
 * Correct send metadata on an already-sent invoice. Does not create a second send event
 * and does not change status away from versendet.
 */
export function updateInvoiceSentDetails(
  vorgangId: string,
  invoiceId: string,
  input: InvoiceSentInput,
): InvoiceSentMutationResult {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { ok: false, reason: 'invoice_missing' };
  }
  if (invoice.status !== 'versendet') {
    return { ok: false, reason: 'not_sent' };
  }

  const parsed = parseSentInput(input);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  const updated = updateInvoiceSentFields(vorgangId, invoiceId, {
    status: 'versendet',
    sentAt: parsed.value.sentAt,
    sentVia: parsed.value.sentVia,
    sentNote: parsed.value.sentNote,
  });
  if (!updated.ok) {
    return { ok: false, reason: updated.reason === 'persist_failed' ? 'persist_failed' : 'update_failed' };
  }
  return { ok: true, invoice: updated.invoice };
}

export function formatInvoiceSentViaLabel(
  via: InvoiceSentVia | undefined,
  translate: (key: TranslationKey) => string,
): string {
  if (!via) return translate('invoice.sent.via.unknown');
  return translate(`invoice.sent.via.${via}` as TranslationKey);
}
