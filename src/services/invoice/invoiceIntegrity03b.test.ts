/**
 * RECHNUNGSINTEGRITAET-03B — wo die Serverhärtung den Client berührt.
 *
 * A  Die Übermengen-Bestätigung des Nutzers erreicht den Server als eigener
 *    Parameter — nicht als Belegfeld und nicht im Fingerabdruck.
 * B  Die neuen Serverbefunde werden benannt, nicht verschluckt: Jeder bekommt
 *    eine eigene Fehlerkategorie, einen belegbaren Cloud-Zustand und eine
 *    verständliche Meldung.
 */
import { describe, expect, it } from 'vitest';
import { mapCloudErrorForTests } from './invoicePreparedFinalizeService';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';
import {
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';
import type { WorkspaceInvoiceCloudErrorCode } from './workspaceInvoiceCloudService';
import type { StartInvoiceDraftFinalizationResult } from './invoiceFinalizationCoordinator';

type Failure = Extract<StartInvoiceDraftFinalizationResult, { ok: false }>;

function failure(reason: Failure['reason'], cloudState: Failure['cloudState'] = 'not_committed'): Failure {
  return { ok: false, reason, recovery: 'retry_allowed', cloudState } as Failure;
}

describe('A — die Übermengen-Bestätigung reist bis zum Server', () => {
  it('der vorbereitete Request trägt sie als eigenes Feld', () => {
    const request = {
      kind: PREPARED_FINALIZE_REQUEST_KIND,
      formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
      workspaceId: 'ws-1',
      vorgangId: 'v-1',
      clientInvoiceId: 'inv-1',
      invoice: {},
      invoicePayload: {},
      overbillingAcknowledged: true,
      expectedResponseProjectionRawJson: '{}',
    };
    // Der Validator kennt das Feld: Ein unbekannter Schluessel wuerde hier abgewiesen.
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(request);
    expect(result.ok).toBe(false);
    // Der Ablehnungsgrund ist die leere Beleghuelle, nicht das neue Feld.
    if (!result.ok) expect(result.detail).not.toContain('overbillingAcknowledged');

    // Ohne das Feld bleibt der Request gueltig (Bestandsrequests) — der Server
    // liest dann 'false' und laesst keine Ueberschreitung zu.
    const ohne = validatePreparedWorkspaceInvoiceFinalizeRequest({ ...request, overbillingAcknowledged: undefined });
    expect(ohne.ok).toBe(false);
    if (!ohne.ok) expect(ohne.detail).not.toContain('overbillingAcknowledged');

    // Und sie muss ein echtes Boolean sein.
    const falsch = validatePreparedWorkspaceInvoiceFinalizeRequest({ ...request, overbillingAcknowledged: 'true' });
    expect(falsch.ok).toBe(false);
    if (!falsch.ok) expect(falsch.detail).toContain('overbillingAcknowledged');
  });

  it('ein unbekanntes Zusatzfeld bleibt abgewiesen', () => {
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest({
      kind: PREPARED_FINALIZE_REQUEST_KIND,
      formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
      workspaceId: 'ws-1',
      vorgangId: 'v-1',
      clientInvoiceId: 'inv-1',
      invoice: {},
      invoicePayload: {},
      overbillingAcknowledged: true,
      erfundenesFeld: 1,
      expectedResponseProjectionRawJson: '{}',
    });
    expect(result.ok).toBe(false);
  });
});

describe('B — Serverbefunde werden benannt und verständlich angezeigt', () => {
  it('jede neue Fehlerkategorie führt zu einem eigenen, nicht committeten Ausgang', () => {
    const faelle: Array<[WorkspaceInvoiceCloudErrorCode, string]> = [
      ['quantity_exceeds_available', 'quantity_exceeds_available'],
      ['position_not_found', 'server_integrity_rejected'],
      ['position_not_billable', 'server_integrity_rejected'],
      ['position_mismatch', 'server_integrity_rejected'],
      ['tax_status_mismatch', 'server_integrity_rejected'],
      ['totals_mismatch', 'server_integrity_rejected'],
      ['customer_mismatch', 'server_integrity_rejected'],
    ];
    for (const [code, reason] of faelle) {
      const mapped = mapCloudErrorForTests(code, `${code}: Detail`);
      expect(mapped.reason, code).toBe(reason);
      // Der Guard läuft vor dem Insert — es wurde nachweislich nichts geschrieben.
      expect(mapped.cloudState, code).toBe('not_committed');
    }
  });

  it('bestehende Ausgänge bleiben unverändert', () => {
    expect(mapCloudErrorForTests('idempotency_conflict', 'Idempotenzkonflikt').reason).toBe('idempotency_conflict');
    expect(mapCloudErrorForTests('final_invoice_exists', 'invoice_final_already_exists').reason).toBe('final_invoice_exists');
    expect(mapCloudErrorForTests('validation', 'invoice positions fehlen').reason).toBe('rpc_failed');
    expect(mapCloudErrorForTests('network', 'Failed to fetch').cloudState).toBe('unknown');
    expect(mapCloudErrorForTests('unknown', 'irgendwas').cloudState).toBe('unknown');
  });

  it('die Meldungen sagen, was zu tun ist, und geben den Entwurf wieder frei', () => {
    const menge = mapFinalizationFailureToUx(failure('quantity_exceeds_available'));
    expect(menge.messageKey).toBe('invoice.approve.quantityExceeded');
    expect(menge.unlock).toBe(true);

    const integritaet = mapFinalizationFailureToUx(failure('server_integrity_rejected'));
    expect(integritaet.messageKey).toBe('invoice.approve.serverRejected');
    expect(integritaet.unlock).toBe(true);

    // 03B2 — der fail-closed Preflight sagt jetzt, was los ist, statt nur zu scheitern.
    const abgleich = mapFinalizationFailureToUx(failure('pull_incomplete'));
    expect(abgleich.messageKey).toBe('invoice.approve.syncIncomplete');
    expect(mapFinalizationFailureToUx(failure('pull_failed')).messageKey).toBe('invoice.approve.syncIncomplete');
    expect(mapFinalizationFailureToUx(failure('merge_conflict')).messageKey).toBe('invoice.approve.syncIncomplete');

    // Unveränderte Ausgänge.
    expect(mapFinalizationFailureToUx(failure('idempotency_conflict', 'conflict')).messageKey).toBe('invoice.approve.conflict');
    expect(mapFinalizationFailureToUx(failure('offline_or_unconfigured', 'unknown')).messageKey).toBe('invoice.approve.offline');
    expect(mapFinalizationFailureToUx(failure('rpc_failed', 'unknown')).messageKey).toBe('invoice.approve.failed');
  });
});
