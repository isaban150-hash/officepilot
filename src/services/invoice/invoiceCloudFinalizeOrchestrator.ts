import type { CompanySetup, InvoiceDraft, VorgangInvoice } from '../../types/models';
import { isSupabaseConfigured, getSupabaseClient } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getVorgangById } from '../vorgangService';
import { upsertFinalizedInvoiceOnVorgang } from '../vorgangService';
import { archiveOutgoingInvoice } from '../invoiceArchiveService';
import {
  buildInvoiceFinalizationCandidate,
  buildInvoiceFinalizationContentFingerprint,
} from '../invoiceService';
import type { InvoiceApprovalOptions, InvoiceValidationResult } from '../invoiceValidationService';
import {
  clearInvoiceFinalizeIntent,
  resolveInvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';
import {
  buildWorkspaceInvoiceFinalizeInput,
  rpcFinalizeWorkspaceInvoice,
  WorkspaceInvoiceCloudError,
} from './workspaceInvoiceCloudService';

export type CloudFinalizeFailureReason =
  | 'validation_failed'
  | 'vorgang_missing'
  | 'offline_or_unconfigured'
  | 'auth_missing'
  | 'workspace_missing'
  | 'rpc_failed'
  | 'idempotency_conflict'
  | 'amendment_state_stale'
  | 'local_persist_failed'
  | 'local_conflict';

export type CloudFinalizeInvoiceResult =
  | {
      ok: true;
      invoice: VorgangInvoice;
      archiveWarning?: boolean;
      idempotentReplay: boolean;
    }
  | {
      ok: false;
      reason: CloudFinalizeFailureReason;
      message?: string;
      validation?: InvoiceValidationResult;
    };

async function hasAuthSession(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  return Boolean(!error && data.session);
}

function resolveActiveWorkspaceId(): string {
  return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
}

/**
 * CLOUD-ORDER-CHAIN-03B1: Confirm-first finalize via atomic cloud RPC.
 * Does not call reserveNextInvoiceNumber.
 */
export async function finalizeInvoiceDraftWithCloud(
  vorgangId: string,
  draft: InvoiceDraft,
  setup: CompanySetup,
  options: InvoiceApprovalOptions = {},
): Promise<CloudFinalizeInvoiceResult> {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { ok: false, reason: 'vorgang_missing' };
  }

  const fingerprint = buildInvoiceFinalizationContentFingerprint(draft, setup);

  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      reason: 'offline_or_unconfigured',
      message: 'Cloud ist nicht konfiguriert.',
    };
  }

  if (!(await hasAuthSession())) {
    return { ok: false, reason: 'auth_missing', message: 'Keine gültige Anmeldung.' };
  }

  const workspaceId = resolveActiveWorkspaceId();
  if (!workspaceId) {
    return { ok: false, reason: 'workspace_missing', message: 'Kein aktiver Workspace.' };
  }

  const intent = resolveInvoiceFinalizeIntent({
    workspaceId,
    vorgangId,
    contentFingerprint: fingerprint,
  });

  const candidate = buildInvoiceFinalizationCandidate(
    vorgangId,
    draft,
    setup,
    intent.clientInvoiceId,
    options,
  );
  if (!candidate.ok) {
    return candidate;
  }

  let cloudInvoice: VorgangInvoice;
  let idempotentReplay = false;
  try {
    const rpcResult = await rpcFinalizeWorkspaceInvoice(
      buildWorkspaceInvoiceFinalizeInput(workspaceId, vorgangId, candidate.invoice),
    );
    cloudInvoice = rpcResult.invoice;
    idempotentReplay = rpcResult.idempotentReplay;
  } catch (error) {
    if (error instanceof WorkspaceInvoiceCloudError) {
      if (error.code === 'idempotency_conflict') {
        return {
          ok: false,
          reason: 'idempotency_conflict',
          message: error.message,
        };
      }
      if (error.message.includes('invoice_amendment_state_stale')) {
        return {
          ok: false,
          reason: 'amendment_state_stale',
          message: error.message,
        };
      }
      if (error.code === 'auth') {
        return { ok: false, reason: 'auth_missing', message: error.message };
      }
      if (error.code === 'rls') {
        return { ok: false, reason: 'rpc_failed', message: error.message };
      }
      if (error.code === 'network') {
        return {
          ok: false,
          reason: 'offline_or_unconfigured',
          message: error.message,
        };
      }
      return { ok: false, reason: 'rpc_failed', message: error.message };
    }
    return {
      ok: false,
      reason: 'rpc_failed',
      message: error instanceof Error ? error.message : 'Unbekannter RPC-Fehler',
    };
  }

  // Ensure local identity matches client/server id.
  const finalized: VorgangInvoice = {
    ...cloudInvoice,
    id: intent.clientInvoiceId,
    paymentStatus: cloudInvoice.paymentStatus ?? 'offen',
    payments: cloudInvoice.payments ?? [],
  };

  const upsert = upsertFinalizedInvoiceOnVorgang(vorgangId, finalized);
  if (!upsert.ok) {
    // Keep intent for retry with same client_invoice_id.
    if (upsert.reason === 'vorgang_missing') {
      return { ok: false, reason: 'local_persist_failed', message: 'Vorgang fehlt lokal.' };
    }
    return {
      ok: false,
      reason: 'local_conflict',
      message:
        upsert.reason === 'number_id_conflict'
          ? 'Rechnungsnummer kollidiert lokal mit anderer ID.'
          : 'Lokaler Konflikt: gleicher Beleg mit abweichendem Inhalt.',
    };
  }

  clearInvoiceFinalizeIntent(vorgangId);

  const archiveResult = archiveOutgoingInvoice(vorgangId, upsert.invoice, setup.companyName);
  if (archiveResult.success) {
    return {
      ok: true,
      invoice: archiveResult.invoice,
      idempotentReplay,
    };
  }

  return {
    ok: true,
    invoice: upsert.invoice,
    archiveWarning: true,
    idempotentReplay,
  };
}
