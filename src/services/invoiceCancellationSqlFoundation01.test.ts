import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyInvoiceCloudErrorForTests,
  buildWorkspaceInvoiceFinalizePayload,
} from './invoice/workspaceInvoiceCloudService';
import { buildInvoicePayloadV1 } from './invoice/workspaceInvoiceFinalizeRequestValidator';
import type { VorgangInvoice } from '../types/models';

/**
 * FINAL-INVOICE-CANCELLATION-SERVER-FOUNDATION-01C — die serverseitige
 * Storno-Grundlage.
 *
 * **Was diese Tests beweisen können und was nicht:** Echte Nebenläufigkeit
 * braucht eine echte Datenbank; Vitest hat keine. Geprüft wird die *Struktur*
 * des SQL — Bedingungen, Reihenfolge, Sperren, Fehlernamen. Dass PostgreSQL
 * sich zur Laufzeit so verhält, steht erst beim Dry-Run fest. Hier wird keine
 * Laufzeitgarantie behauptet. Dieselbe Grenze gilt seit 01D.
 */

const sql = (() => {
  try {
    return readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20250905120000_workspace_invoice_cancellation.sql'),
      'utf8',
    );
  } catch {
    return '';
  }
})();

/** Schneidet den Rumpf einer Funktion bis zum nächsten `create or replace`. */
function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  if (start < 0) return '';
  const next = sql.indexOf('create or replace function public.', start + 1);
  return next < 0 ? sql.slice(start) : sql.slice(start, next);
}

const cancelFn = functionBody('cancel_workspace_invoice');
const addPaymentFn = functionBody('add_workspace_invoice_payment');
const reversePaymentFn = functionBody('reverse_workspace_invoice_payment');

describe('Storno-Wahrheit im Schema', () => {
  it('A: die drei Spalten und der Begründungszwang existieren', () => {
    expect(sql).toContain('add column if not exists cancelled_at timestamptz null');
    expect(sql).toContain('add column if not exists cancelled_by uuid null');
    expect(sql).toContain('add column if not exists cancel_reason text null');
    expect(sql).toContain('workspace_invoices_cancel_reason_check');
    expect(sql).toContain(
      'check (cancelled_at is null or length(btrim(coalesce(cancel_reason, \'\'))) > 0)',
    );
  });

  it('B: ein gelöschter Benutzer löscht die Stornohistorie nicht mit', () => {
    /* Dasselbe Muster wie `created_by`/`reversed_by`/`updated_by`. */
    expect(sql).toContain('references auth.users (id) on delete set null');
    expect(sql).not.toContain('cancelled_by uuid not null');
  });
});

describe('cancel_workspace_invoice', () => {
  it('C: nur Schlussrechnungen sind stornierbar', () => {
    expect(cancelFn).toContain("v_existing.invoice_type is distinct from 'schluss'");
    expect(cancelFn).toContain('invoice_cancel_type_not_supported');
  });

  it('D: ein Entwurf wird nicht storniert', () => {
    expect(cancelFn).toContain("v_existing.invoice_status not in ('vorbereitet', 'versendet')");
    expect(cancelFn).toContain('invoice_cancel_not_finalized');
  });

  it('E: Zeitpunkt und Urheber entstehen serverseitig, nicht im Client', () => {
    expect(cancelFn).toContain('cancelled_at = now()');
    expect(cancelFn).toContain('cancelled_by = v_user_id');
    expect(cancelFn).toContain('v_user_id uuid := auth.uid()');
    /* Es gibt keinen Parameter für Zeitpunkt oder Urheber. */
    expect(sql).toContain('public.cancel_workspace_invoice(\n  p_workspace_id uuid,');
    expect(cancelFn).not.toContain('p_cancelled_at');
    expect(cancelFn).not.toContain('p_cancelled_by');
  });

  it('F: ohne Begründung wird nicht storniert', () => {
    expect(cancelFn).toContain('invoice_cancel_reason_required');
    expect(cancelFn).toContain('btrim(coalesce(p_reason');
  });

  it('G: eine aktive Zahlung verhindert das Storno, ohne etwas zurückzubuchen', () => {
    expect(cancelFn).toContain('p.reversed_at is null');
    expect(cancelFn).toContain('invoice_cancel_has_active_payments');
    /* Keine stille Rückabwicklung. */
    expect(cancelFn).not.toContain('update public.workspace_invoice_payments');
  });

  it('H: der zweite Aufruf ist ein Replay und überschreibt den Grund nicht', () => {
    const idempotentAt = cancelFn.indexOf('v_existing.cancelled_at is not null');
    const typeCheckAt = cancelFn.indexOf('invoice_cancel_type_not_supported');
    const paymentCheckAt = cancelFn.indexOf('invoice_cancel_has_active_payments');
    const updateAt = cancelFn.indexOf('update public.workspace_invoices');

    expect(idempotentAt).toBeGreaterThan(-1);
    // Replay vor jeder weiteren Prüfung und vor dem Schreiben.
    expect(idempotentAt).toBeLessThan(typeCheckAt);
    expect(idempotentAt).toBeLessThan(paymentCheckAt);
    expect(idempotentAt).toBeLessThan(updateAt);
  });

  it('I: Status, Nummer und Historie bleiben unangetastet', () => {
    expect(cancelFn).not.toContain('invoice_status =');
    expect(cancelFn).not.toContain('invoice_number =');
    expect(cancelFn).not.toContain('delete from');
  });

  it('J: Lock-Reihenfolge Vorgang → Rechnung → Zahlungen', () => {
    const vorgangAt = cancelFn.indexOf('public.workspace_vorgaenge');
    const invoiceLockAt = cancelFn.indexOf('from public.workspace_invoices\n  where workspace_id');
    const paymentsAt = cancelFn.indexOf('from public.workspace_invoice_payments');

    expect(vorgangAt).toBeGreaterThan(-1);
    expect(invoiceLockAt).toBeGreaterThan(vorgangAt);
    expect(paymentsAt).toBeGreaterThan(invoiceLockAt);
    expect(cancelFn).not.toContain('pg_advisory');
  });

  it('K: die Ausführungsrechte folgen dem bestehenden Muster', () => {
    expect(sql).toContain('revoke all on function public.cancel_workspace_invoice');
    expect(sql).toContain('grant execute on function public.cancel_workspace_invoice');
    expect(cancelFn).toContain('public.is_active_workspace_member(p_workspace_id)');
    expect(cancelFn).toContain('public.can_write_workspace(p_workspace_id)');
  });
});

describe('Zahlungspfad teilt den Serialisierungspunkt', () => {
  it('L: add_workspace_invoice_payment sperrt die Rechnungszeile', () => {
    const invoiceSelectAt = addPaymentFn.indexOf('from public.workspace_invoices');
    const forUpdateAt = addPaymentFn.indexOf('for update', invoiceSelectAt);
    const insertAt = addPaymentFn.indexOf('insert into public.workspace_invoice_payments');

    expect(invoiceSelectAt).toBeGreaterThan(-1);
    expect(forUpdateAt).toBeGreaterThan(invoiceSelectAt);
    // Sperre und Prüfung stehen vor dem Insert.
    expect(forUpdateAt).toBeLessThan(insertAt);
  });

  it('M: die Stornoprüfung liest die Spalte, nicht den Payload', () => {
    expect(addPaymentFn).toContain('v_invoice.cancelled_at is not null');
    expect(addPaymentFn).not.toContain("payload->>'cancelledAt'");
  });

  it('N: die bestehende Zahlungs-Idempotenz bleibt unverändert', () => {
    expect(addPaymentFn).toContain('on conflict (workspace_id, client_invoice_id, client_payment_id) do nothing');
    expect(addPaymentFn).toContain('Zahlungskonflikt: diese Zahlung wurde storniert');
    expect(addPaymentFn).toContain('Zahlung Nachbedingung verletzt');
  });

  it('O: das Reversal sperrt die Rechnung vor der Zahlung', () => {
    const invoiceAt = reversePaymentFn.indexOf('from public.workspace_invoices');
    const paymentAt = reversePaymentFn.indexOf('from public.workspace_invoice_payments');
    expect(invoiceAt).toBeGreaterThan(-1);
    expect(paymentAt).toBeGreaterThan(invoiceAt);
    /* Eine Zahlung bleibt auch auf einer stornierten Rechnung zurücknehmbar —
       genau das macht eine bezahlte Rechnung überhaupt stornierbar. */
    expect(reversePaymentFn).not.toContain('cancelled_at is not null');
  });
});

describe('Der Client kann kein Storno einschleusen', () => {
  const invoice = {
    id: 'inv-1',
    number: '2026-0001',
    type: 'schluss',
    positions: [],
    subtotal: 100,
    taxStatus: 'tax_free',
    amount: 100,
    status: 'vorbereitet',
    date: '2026-03-01',
    createdAt: '2026-03-01T08:00:00.000Z',
    cancelledAt: '2026-03-05T10:00:00.000Z',
    cancelReason: 'eingeschleust',
    expectedAmendmentSequence: 0,
  } as unknown as VorgangInvoice;

  it('P: der Finalize-Payload trägt cancelledAt/cancelReason nicht mehr', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(invoice);
    expect(payload.cancelledAt).toBeUndefined();
    expect(payload.cancelReason).toBeUndefined();
    // Der übrige Beleg bleibt vollständig.
    expect(payload.amount).toBe(100);
    expect(payload.type).toBe('schluss');
  });

  it('Q: auch die festgeschriebene Version-1-Abbildung lässt sie fallen', () => {
    const payload = buildInvoicePayloadV1(invoice);
    expect(payload).not.toBeNull();
    expect(payload!.cancelledAt).toBeUndefined();
    expect(payload!.cancelReason).toBeUndefined();
    expect(payload!.cancelledBy).toBeUndefined();
  });

  it('R: der SQL-Normalizer entfernt sie zusätzlich', () => {
    const normalizer = functionBody('normalize_workspace_invoice_payload_for_idempotency');
    expect(normalizer).toContain("- 'cancelledAt'");
    expect(normalizer).toContain("- 'cancelReason'");
    expect(normalizer).toContain("- 'cancelledBy'");
  });
});

describe('Stornogründe erreichen den Aufrufer benennbar', () => {
  it('S: jeder Serverfehler bekommt seinen eigenen Code', () => {
    const cases: Array<[string, string]> = [
      ['invoice_cancel_type_not_supported', 'cancel_type_not_supported'],
      ['invoice_cancel_not_finalized', 'cancel_not_finalized'],
      ['invoice_cancel_has_active_payments', 'cancel_has_active_payments'],
      ['invoice_cancel_reason_required', 'cancel_reason_required'],
      ['Rechnung nicht gefunden', 'not_found'],
    ];
    for (const [message, expected] of cases) {
      const classified = classifyInvoiceCloudErrorForTests({ message });
      expect(classified.code, message).toBe(expected);
      // Fail-closed: keiner dieser Fehler ist wiederholbar.
      expect(classified.retryable, message).toBe(false);
    }
  });

  it('T: der Single-Final-Fehler bleibt unverändert abgebildet', () => {
    expect(classifyInvoiceCloudErrorForTests({ message: 'invoice_final_already_exists' }).code).toBe(
      'final_invoice_exists',
    );
  });
});
