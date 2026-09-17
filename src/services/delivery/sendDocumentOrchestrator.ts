import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, getSupabaseUrl, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { getActiveStorageScope } from '../storage/storageScopeService';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import { getVorgangInvoice, updateInvoiceSentFields } from '../vorgangService';
import type { DeliveryDocumentIdentity, DeliveryStatus, DocumentDelivery } from '../../types/documentDelivery';
import type { VorgangInvoice } from '../../types/models';
import { isValidRecipientEmail, normalizeRecipientEmail } from './documentDeliveryContract';
import {
  prepareInvoiceDeliveryAttachment,
  rpcCreateWorkspaceDocumentDelivery,
  rpcListWorkspaceDocumentDeliveries,
  uploadDeliveryAttachment,
} from './documentDeliveryCloudService';

/**
 * EMAIL-01B3 — der Client-Orchestrator des Versands.
 *
 * Genau eine Kette, keine Businesslogik im Click-Handler:
 *   1. historisches PDF (bestehende Engine) → 2. SHA-256 → 3. Anhang →
 *   4. privater Upload (inhaltsadressiert, Replay-sicher) →
 *   5. `create_workspace_document_delivery` (idempotent über client_delivery_id) →
 *   6. Edge Function `send-document` → 7. autoritativen Status laden →
 *   8. lokale Rechnung aus der Serverwahrheit nachziehen.
 *
 * Die `client_delivery_id` entsteht **vor** Upload/Create/Send und bleibt
 * für denselben technischen Versuch stabil (Doppelklick, Reload, Retry
 * desselben Versuchs). Ein bewusster neuer Versuch nach `failed` bekommt
 * eine neue ID und `retryOfDeliveryId`.
 *
 * Resume: ein noch nicht abgeschlossener Versuch liegt als kleiner
 * Primitiv-Datensatz in localStorage (Scope + Rechnung), ohne PDF-Bytes,
 * ohne Providerdaten. Nach Reload wird der Serverstatus geladen:
 * provider_accepted/unknown → nie erneut senden; failed → bewusster Retry.
 */

export type SendPhase = 'draft' | 'preparing' | 'uploading' | 'creating' | 'sending' | 'refreshing' | 'done';

export interface SendDraftState {
  version: 1;
  scopeKey: string;
  workspaceId: string;
  identity: DeliveryDocumentIdentity;
  vorgangId: string | null;
  clientDeliveryId: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  attachmentSha256?: string;
  attachmentStoragePath?: string;
  attachmentSizeBytes?: number;
  attachmentFilename?: string;
  retryOfDeliveryId?: string;
  phase: SendPhase;
  updatedAt: string;
}

const STORAGE_PREFIX = 'officepilot.sendDraft.v1';

export function sendDraftStorageKey(scopeKey: string, identity: DeliveryDocumentIdentity): string {
  return `${STORAGE_PREFIX}:${scopeKey}:${identity.kind}:${identity.clientInvoiceId}`;
}

function currentScopeKey(): string {
  return buildDocumentBlobScopeKey(getActiveStorageScope());
}

export function loadSendDraft(identity: DeliveryDocumentIdentity, scopeKey = currentScopeKey()): SendDraftState | null {
  try {
    const raw = localStorage.getItem(sendDraftStorageKey(scopeKey, identity));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SendDraftState;
    if (parsed?.version !== 1 || parsed.scopeKey !== scopeKey) return null;
    if (parsed.identity?.kind !== identity.kind || parsed.identity?.clientInvoiceId !== identity.clientInvoiceId) return null;
    if (typeof parsed.clientDeliveryId !== 'string' || !parsed.clientDeliveryId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSendDraft(draft: SendDraftState): void {
  try {
    localStorage.setItem(sendDraftStorageKey(draft.scopeKey, draft.identity), JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }));
  } catch {
    /* Speicher nicht verfügbar — der Versand funktioniert auch ohne Resume. */
  }
}

export function clearSendDraft(identity: DeliveryDocumentIdentity, scopeKey = currentScopeKey()): void {
  try {
    localStorage.removeItem(sendDraftStorageKey(scopeKey, identity));
  } catch {
    /* ignorieren */
  }
}

export function generateClientDeliveryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `cd-${crypto.randomUUID()}`;
  throw new Error('DELIVERY: sichere Zufallsquelle nicht verfügbar.');
}

export function resolveDeliveryWorkspaceId(): string {
  return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
}

export interface NewSendDraftInput {
  identity: DeliveryDocumentIdentity;
  vorgangId: string | null;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  retryOfDeliveryId?: string;
}

/** Neuer Versuch: neue client_delivery_id — vor jedem Upload/Create/Send. */
export function createSendDraft(input: NewSendDraftInput): SendDraftState {
  const draft: SendDraftState = {
    version: 1,
    scopeKey: currentScopeKey(),
    workspaceId: resolveDeliveryWorkspaceId(),
    identity: input.identity,
    vorgangId: input.vorgangId,
    clientDeliveryId: generateClientDeliveryId(),
    recipientEmail: normalizeRecipientEmail(input.recipientEmail),
    subject: input.subject.trim(),
    bodyText: input.bodyText,
    retryOfDeliveryId: input.retryOfDeliveryId,
    phase: 'draft',
    updatedAt: new Date().toISOString(),
  };
  saveSendDraft(draft);
  return draft;
}

export type SendDocumentClientError =
  | 'not_configured'
  | 'workspace_missing'
  | 'invoice_missing'
  | 'invalid_recipient'
  | 'pdf_failed'
  | 'upload_failed'
  | 'idempotency_conflict'
  | 'forbidden'
  | 'not_sendable'
  | 'uncertain_pending'
  | 'server_unavailable'
  | 'unauthenticated'
  | 'rpc_failed';

export type SendDocumentClientResult =
  | { ok: true; action: 'sent' | 'replayed' | 'unknown_pending' | 'failed'; delivery: DocumentDelivery; deliveries: DocumentDelivery[] }
  | { ok: false; error: SendDocumentClientError; message?: string; draft: SendDraftState };

export interface SendDocumentServerResponse {
  ok: boolean;
  action?: 'sent' | 'replayed' | 'unknown_pending' | 'failed';
  error?: string;
  delivery?: { id: string; status: DeliveryStatus; providerMessageId: string | null; errorCategory: string | null; errorCode: string | null; errorMessageSafe: string | null; rowVersion: number };
}

export interface SendDocumentDeps {
  client?: SupabaseClient | null;
  /** Testbar: ruft die Edge Function auf. */
  invokeSend?: (input: { workspaceId: string; clientDeliveryId: string }) => Promise<{ status: number; body: SendDocumentServerResponse }>;
  onPhase?: (phase: SendPhase) => void;
  now?: () => string;
}

async function defaultInvokeSend(client: SupabaseClient, input: { workspaceId: string; clientDeliveryId: string }): Promise<{ status: number; body: SendDocumentServerResponse }> {
  const baseUrl = getSupabaseUrl();
  const { data: sessionData } = await client.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!baseUrl || !accessToken) return { status: 401, body: { ok: false, error: 'unauthenticated' } };
  const response = await fetch(`${baseUrl}/functions/v1/send-document`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({ ok: false, error: 'invalid_response' }))) as SendDocumentServerResponse;
  return { status: response.status, body };
}

/**
 * Serverwahrheit in die lokale Rechnung ziehen: nach provider_accepted ist
 * die Rechnung versendet (email/officepilot/delivery). Keine optimistische
 * Umschaltung — nur nach bestätigter Server-Antwort/-Historie.
 */
export function applyAcceptedDeliveryToLocalInvoice(vorgangId: string | null, invoice: VorgangInvoice, delivery: DocumentDelivery): VorgangInvoice {
  if (delivery.documentKind !== 'invoice') return invoice;
  if (!(delivery.status === 'provider_accepted' || delivery.status === 'delivered' || delivery.status === 'bounced' || delivery.status === 'complained')) return invoice;
  if (invoice.sentSource === 'officepilot' && invoice.sentDeliveryId && invoice.sentDeliveryId !== delivery.id) return invoice;
  if (invoice.sentDeliveryId === delivery.id && invoice.status === 'versendet') return invoice;
  const priorManual =
    invoice.status === 'versendet' && invoice.sentSource !== 'officepilot' && invoice.sentAt && invoice.sentVia
      ? { sentAt: invoice.sentAt, sentVia: invoice.sentVia, sentNote: invoice.sentNote }
      : undefined;
  const updated = updateInvoiceSentFields(vorgangId, invoice.id, {
    status: 'versendet',
    sentAt: (delivery.providerAcceptedAt ?? delivery.requestedAt).slice(0, 10),
    sentVia: 'email',
    sentSource: 'officepilot',
    sentDeliveryId: delivery.id,
    sentManualPrior: priorManual,
  });
  return updated.ok ? updated.invoice : invoice;
}

/** Historie laden und die lokale Rechnung aus der Serverwahrheit nachziehen. */
export async function refreshDeliveries(
  input: { vorgangId: string | null; invoice: VorgangInvoice; identity: DeliveryDocumentIdentity },
  deps: SendDocumentDeps = {},
): Promise<{ ok: true; deliveries: DocumentDelivery[]; invoice: VorgangInvoice } | { ok: false; error: SendDocumentClientError }> {
  const client = deps.client ?? getSupabaseClient();
  if (!client || !isSupabaseConfigured()) return { ok: false, error: 'not_configured' };
  const workspaceId = resolveDeliveryWorkspaceId();
  if (!workspaceId) return { ok: false, error: 'workspace_missing' };
  const listed = await rpcListWorkspaceDocumentDeliveries({ workspaceId, identity: input.identity }, client);
  if (!listed.ok) return { ok: false, error: listed.error === 'forbidden' ? 'forbidden' : 'rpc_failed' };
  let invoice = getVorgangInvoice(input.vorgangId, input.invoice.id) ?? input.invoice;
  const accepted = listed.deliveries.find((d) => d.status === 'provider_accepted' || d.status === 'delivered' || d.status === 'bounced' || d.status === 'complained');
  if (accepted) invoice = applyAcceptedDeliveryToLocalInvoice(input.vorgangId, invoice, accepted);
  return { ok: true, deliveries: listed.deliveries, invoice };
}

/**
 * Führt einen Versuch aus bzw. setzt ihn fort. Idempotent: derselbe Draft
 * (gleiche client_delivery_id) erzeugt nie eine zweite Mail — Upload ist
 * inhaltsadressiert, Create replayt, send-document replayt.
 */
export async function runSendDocument(
  input: { draft: SendDraftState; vorgangId: string | null },
  deps: SendDocumentDeps = {},
): Promise<SendDocumentClientResult> {
  const client = deps.client ?? getSupabaseClient();
  let draft = input.draft;
  const phase = (next: SendPhase) => {
    draft = { ...draft, phase: next };
    saveSendDraft(draft);
    deps.onPhase?.(next);
  };
  const failWith = (error: SendDocumentClientError, message?: string): SendDocumentClientResult => ({ ok: false, error, message, draft });

  if (!client || !isSupabaseConfigured()) return failWith('not_configured');
  if (!draft.workspaceId) return failWith('workspace_missing');
  if (!isValidRecipientEmail(draft.recipientEmail)) return failWith('invalid_recipient');

  const invoice = getVorgangInvoice(input.vorgangId, draft.identity.clientInvoiceId);
  if (!invoice) return failWith('invoice_missing');

  // 1–3: historisches PDF + Hash (nur wenn der Anhang dieses Versuchs noch nicht gesichert ist).
  if (!draft.attachmentStoragePath || !draft.attachmentSha256) {
    phase('preparing');
    const prepared = await prepareInvoiceDeliveryAttachment(invoice, draft.identity);
    if (!prepared.ok) return failWith('pdf_failed', prepared.reason);
    // 4: Upload — vorhandenes Objekt (gleicher Hash) gilt als Erfolg, kein zweiter Upload.
    phase('uploading');
    const uploaded = await uploadDeliveryAttachment({ workspaceId: draft.workspaceId, identity: draft.identity, attachment: prepared.attachment }, client);
    if (!uploaded.ok) return failWith('upload_failed', uploaded.error);
    draft = {
      ...draft,
      attachmentStoragePath: uploaded.storagePath,
      attachmentSha256: prepared.attachment.sha256,
      attachmentSizeBytes: prepared.attachment.sizeBytes,
      attachmentFilename: prepared.attachment.filename,
    };
    saveSendDraft(draft);
  }

  // 5: Delivery anlegen — Replay liefert dieselbe Zeile.
  phase('creating');
  const created = await rpcCreateWorkspaceDocumentDelivery(
    {
      workspaceId: draft.workspaceId,
      clientDeliveryId: draft.clientDeliveryId,
      identity: draft.identity,
      recipientEmail: draft.recipientEmail,
      subject: draft.subject,
      bodyText: draft.bodyText,
      attachment: {
        storagePath: draft.attachmentStoragePath!,
        sha256: draft.attachmentSha256!,
        sizeBytes: draft.attachmentSizeBytes!,
        filename: draft.attachmentFilename!,
      },
      provider: resolveClientMailProvider(),
      retryOfDeliveryId: draft.retryOfDeliveryId,
    },
    client,
  );
  if (!created.ok) {
    if (created.error === 'idempotency_conflict') return failWith('idempotency_conflict', created.message);
    if (created.error === 'forbidden') return failWith('forbidden', created.message);
    if (created.error === 'not_sendable' || created.error === 'not_found') return failWith('not_sendable', created.message);
    if (created.error === 'invalid_recipient') return failWith('invalid_recipient');
    if (created.error === 'uncertain_pending') return failWith('uncertain_pending', created.message);
    return failWith('rpc_failed', created.message);
  }

  // 6: Server sendet (oder replayt) — nie der Client.
  phase('sending');
  let response: { status: number; body: SendDocumentServerResponse };
  try {
    response = deps.invokeSend ? await deps.invokeSend({ workspaceId: draft.workspaceId, clientDeliveryId: draft.clientDeliveryId }) : await defaultInvokeSend(client, { workspaceId: draft.workspaceId, clientDeliveryId: draft.clientDeliveryId });
  } catch {
    // Antwort verloren: der Server kann angenommen haben — Status laden, nicht erneut senden.
    response = { status: 0, body: { ok: false, error: 'server_unavailable' } };
  }

  // 7: autoritativen Status laden (auch nach verlorener Antwort).
  phase('refreshing');
  const refreshed = await refreshDeliveries({ vorgangId: input.vorgangId, invoice, identity: draft.identity }, { client });
  if (!refreshed.ok) return failWith(refreshed.error);
  const delivery = refreshed.deliveries.find((d) => d.clientDeliveryId === draft.clientDeliveryId) ?? created.delivery;

  if (!response.body.ok) {
    if (delivery.status === 'queued') {
      // Server hat nichts übernommen — Draft bleibt für einen technischen Replay bestehen.
      draft = { ...draft, phase: 'creating' };
      saveSendDraft(draft);
      if (response.status === 401) return failWith('unauthenticated');
      if (response.status === 403) return failWith('forbidden');
      if (response.status === 409) return failWith('not_sendable', response.body.error);
      return failWith('server_unavailable', response.body.error);
    }
  }

  // 8: abgeschlossen — Draft entfernen; die Rechnung wurde in refreshDeliveries nachgezogen.
  phase('done');
  clearSendDraft(draft.identity, draft.scopeKey);
  const action: 'sent' | 'replayed' | 'unknown_pending' | 'failed' =
    delivery.status === 'unknown' ? 'unknown_pending' : delivery.status === 'failed' || delivery.status === 'rejected' ? 'failed' : response.body.action === 'replayed' ? 'replayed' : 'sent';
  return { ok: true, action, delivery, deliveries: refreshed.deliveries };
}

/**
 * Provider-Absicht des Clients (der Server prüft sie gegen MAIL_PROVIDER und
 * lehnt Abweichungen ab). Nur ein ausdrückliches
 * wählt den Stub — der Produktionsdefault ist der echte Provider.
 */
export function resolveClientMailProvider(): 'brevo' | 'stub' {
  const value = (import.meta.env.VITE_MAIL_PROVIDER ?? '').toString().trim().toLowerCase();
  return value === 'stub' ? 'stub' : 'brevo';
}
