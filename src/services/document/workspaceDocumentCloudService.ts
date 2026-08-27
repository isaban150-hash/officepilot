/**
 * OFFICEPILOT-GENERATED-INVOICE-DOCUMENT-CLOUD-05C1 — Archivdokumente reisen mit.
 *
 * Eigener Dienst statt des generischen Sync: `document` bleibt in der
 * Allowlist local-only. Nur eine eng umrissene Klasse geht in die Cloud —
 * selbst erzeugte Ausgangsrechnungs-Dokumente, die eine Rechnung als fachlichen
 * Schluessel haben und deren Datei aus eben dieser Rechnung reproduzierbar ist.
 *
 * Fremddokumente, Belege, Vertraege und Fotos bleiben unberuehrt.
 *
 * Jede Funktion ist total — kein Pfad endet still.
 */
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { isGeneratedInvoicePayloadCompatible } from './documentCloudPullOrchestrator';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Die einzige Dokumentart, die 05C1 in die Cloud laesst. */
export const GENERATED_INVOICE_DOCUMENT_KIND = 'generated_invoice';

/** Eine Dokumentzeile, wie die Cloud sie fuehrt — inklusive Grabstein. */
export interface WorkspaceDocumentRow {
  workspaceId: string;
  clientDocumentId: string;
  documentKind: string;
  linkedInvoiceId: string;
  linkedVorgangId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
  /** Gesetzt heisst: geloescht. Die Zeile bleibt, zaehlt aber nicht mehr. */
  deletedAt?: string;
}

export interface WorkspaceGeneratedInvoiceDocumentUpsertInput {
  /** Stabile lokale Kennung `doc-<uuid>`. Nie neu erzeugt. */
  clientDocumentId: string;
  linkedInvoiceId: string;
  linkedVorgangId?: string;
  payload: Record<string, unknown>;
}

/**
 * Ausgang einer Cloud-Operation. `supabase_not_configured` ist der bewusst
 * lokale Betrieb und kein Fehler; alles andere muss sichtbar werden.
 */
export type DocumentCloudOutcome =
  | 'synced'
  | 'supabase_not_configured'
  | 'workspace_missing'
  | 'conflict'
  | 'failed';

export type DocumentCloudResult =
  | { outcome: 'synced'; row: WorkspaceDocumentRow }
  | { outcome: Exclude<DocumentCloudOutcome, 'synced'>; detail?: string };

export type DocumentCloudPullResult =
  | { outcome: 'synced'; rows: WorkspaceDocumentRow[] }
  | { outcome: Exclude<DocumentCloudOutcome, 'synced'>; detail?: string };

/** Streng: Nur ein bewiesener Erfolg ist ein Erfolg. */
export function isDocumentCloudSynced(outcome: DocumentCloudOutcome): boolean {
  return outcome === 'synced';
}

/**
 * Ohne konfigurierte Cloud gibt es nichts zu sichern und nichts zu verlieren —
 * nur dieser eine Ausgang darf zusaetzlich schweigend hingenommen werden.
 */
export function isDocumentCloudSilent(outcome: DocumentCloudOutcome): boolean {
  return outcome === 'synced' || outcome === 'supabase_not_configured';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseWorkspaceDocumentRow(raw: unknown): WorkspaceDocumentRow | null {
  if (!isPlainObject(raw)) return null;

  const workspaceId = text(raw.workspace_id);
  const clientDocumentId = text(raw.client_document_id);
  const documentKind = text(raw.document_kind);
  const linkedInvoiceId = text(raw.linked_invoice_id);
  const createdAt = text(raw.created_at);
  const updatedAt = text(raw.updated_at);
  const rowVersion =
    typeof raw.row_version === 'number' && Number.isInteger(raw.row_version)
      ? raw.row_version
      : null;

  if (
    !workspaceId ||
    !clientDocumentId ||
    !documentKind ||
    !linkedInvoiceId ||
    !createdAt ||
    !updatedAt ||
    rowVersion === null ||
    rowVersion <= 0 ||
    !isPlainObject(raw.payload)
  ) {
    return null;
  }

  return {
    workspaceId,
    clientDocumentId,
    documentKind,
    linkedInvoiceId,
    linkedVorgangId: optionalText(raw.linked_vorgang_id),
    payload: raw.payload,
    createdAt,
    updatedAt,
    rowVersion,
    deletedAt: optionalText(raw.deleted_at),
  };
}

interface CloudContext {
  client: SupabaseClient;
  workspaceId: string;
}

type ContextResult =
  | { ok: true; context: CloudContext }
  | { ok: false; outcome: Exclude<DocumentCloudOutcome, 'synced' | 'conflict'> };

function resolveContext(override?: {
  client?: SupabaseClient | null;
  workspaceId?: string;
}): ContextResult {
  try {
    if (!override?.client && !isSupabaseConfigured()) {
      return { ok: false, outcome: 'supabase_not_configured' };
    }
    const client = override?.client ?? getSupabaseClient();
    if (!client) return { ok: false, outcome: 'supabase_not_configured' };

    const workspaceId = (
      override?.workspaceId ?? resolveCloudWorkspaceId(buildPersistedStateSnapshot())
    ).trim();
    // Cloud vorhanden, Workspace nicht aufloesbar — das ist ein Fehler, kein Normalfall.
    if (!workspaceId) return { ok: false, outcome: 'workspace_missing' };

    return { ok: true, context: { client, workspaceId } };
  } catch {
    return { ok: false, outcome: 'failed' };
  }
}

/** Ein Konflikt der Fachdaten ist etwas anderes als ein technischer Fehler. */
function isConflictMessage(message: string): boolean {
  return message.includes('Dokumentkonflikt');
}

/**
 * Sichert ein erzeugtes Ausgangsrechnungs-Dokument.
 *
 * Idempotent ueber zwei Schluessel: technisch `(workspace, client_document_id)`
 * und fachlich `(workspace, linked_invoice_id)`. Der zweite ist der wichtigere —
 * zwei Geraete erzeugen lokal verschiedene `doc-`Kennungen fuer dieselbe
 * Rechnung, und in der Cloud darf davon nur eine Zeile ankommen.
 *
 * **Die zurueckgegebene `clientDocumentId` kann deshalb von der gesendeten
 * abweichen.** Das ist kein Fehler, sondern die kanonische Zeile — der Aufrufer
 * muss sich lokal darauf zusammenfuehren.
 */
export async function upsertGeneratedInvoiceDocumentToCloud(
  input: WorkspaceGeneratedInvoiceDocumentUpsertInput,
  override?: { client?: SupabaseClient | null; workspaceId?: string },
): Promise<DocumentCloudResult> {
  const resolved = resolveContext(override);
  if (!resolved.ok) return { outcome: resolved.outcome };
  const { client, workspaceId } = resolved.context;

  const clientDocumentId = input.clientDocumentId.trim();
  const linkedInvoiceId = input.linkedInvoiceId.trim();
  const linkedVorgangId = input.linkedVorgangId?.trim() || undefined;

  if (!clientDocumentId || !linkedInvoiceId) return { outcome: 'failed', detail: 'identity' };
  if (!isPlainObject(input.payload)) return { outcome: 'failed', detail: 'payload' };

  let data: unknown;
  try {
    const response = await client.rpc('upsert_workspace_generated_invoice_document', {
      p_workspace_id: workspaceId,
      p_client_document_id: clientDocumentId,
      p_linked_invoice_id: linkedInvoiceId,
      p_linked_vorgang_id: linkedVorgangId ?? null,
      p_payload: input.payload,
    });
    if (response.error) {
      const message = response.error.message ?? '';
      return {
        outcome: isConflictMessage(message) ? 'conflict' : 'failed',
        detail: message || undefined,
      };
    }
    data = response.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { outcome: isConflictMessage(message) ? 'conflict' : 'failed', detail: message };
  }

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) return { outcome: 'failed', detail: 'row_count' };

  const row = parseWorkspaceDocumentRow(rows[0]);
  if (
    !row ||
    row.workspaceId !== workspaceId ||
    row.documentKind !== GENERATED_INVOICE_DOCUMENT_KIND ||
    row.linkedInvoiceId !== linkedInvoiceId ||
    row.deletedAt !== undefined
  ) {
    return { outcome: 'failed', detail: 'response_mismatch' };
  }

  /*
   * 05C1B — die semantische Pruefung.
   *
   * Kam **unsere** Kennung zurueck, muss die Cloud genau das gespeichert
   * haben, was wir gesendet haben — sonst haette sie etwas anderes
   * geschrieben, als wir wissen. Das ist ein technischer Fehler.
   *
   * Kam eine **fremde** Kennung zurueck, ist das die kanonische Zeile eines
   * anderen Geraets. Eine abweichende Kennung ist erlaubt; abweichende
   * Fachdaten sind es nicht. Sonst uebernaehme ein Geraet stillschweigend die
   * Version eines anderen, und beide hielten Verschiedenes fuer gesichert.
   */
  const compatible = isGeneratedInvoicePayloadCompatible(input.payload, row.payload);

  if (row.clientDocumentId === clientDocumentId) {
    if (!compatible) return { outcome: 'failed', detail: 'payload_mismatch' };
  } else if (!compatible) {
    return { outcome: 'conflict', detail: 'payload_semantics' };
  }

  return { outcome: 'synced', row };
}

/**
 * Setzt den Grabstein. Die Zeile bleibt bestehen — nur so erfaehrt ein anderes
 * Geraet ueberhaupt von der Loeschung.
 */
export async function tombstoneDocumentInCloud(
  input: { clientDocumentId: string },
  override?: { client?: SupabaseClient | null; workspaceId?: string },
): Promise<DocumentCloudResult> {
  const resolved = resolveContext(override);
  if (!resolved.ok) return { outcome: resolved.outcome };
  const { client, workspaceId } = resolved.context;

  const clientDocumentId = input.clientDocumentId.trim();
  if (!clientDocumentId) return { outcome: 'failed', detail: 'identity' };

  let data: unknown;
  try {
    const response = await client.rpc('tombstone_workspace_document', {
      p_workspace_id: workspaceId,
      p_client_document_id: clientDocumentId,
    });
    if (response.error) {
      return { outcome: 'failed', detail: response.error.message ?? undefined };
    }
    data = response.data;
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : undefined };
  }

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) return { outcome: 'failed', detail: 'row_count' };

  const row = parseWorkspaceDocumentRow(rows[0]);
  if (
    !row ||
    row.workspaceId !== workspaceId ||
    row.clientDocumentId !== clientDocumentId ||
    !row.deletedAt
  ) {
    return { outcome: 'failed', detail: 'response_mismatch' };
  }

  return { outcome: 'synced', row };
}

/** Holt die erzeugten Rechnungsdokumente — Grabsteine ausdruecklich eingeschlossen. */
export async function pullDocumentsFromCloud(
  override?: { client?: SupabaseClient | null; workspaceId?: string; since?: string | null },
): Promise<DocumentCloudPullResult> {
  const resolved = resolveContext(override);
  if (!resolved.ok) return { outcome: resolved.outcome };
  const { client, workspaceId } = resolved.context;

  let data: unknown;
  try {
    const response = await client.rpc('pull_workspace_documents', {
      p_workspace_id: workspaceId,
      p_since: override?.since ?? null,
    });
    if (response.error) {
      return { outcome: 'failed', detail: response.error.message ?? undefined };
    }
    data = response.data;
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : undefined };
  }

  if (!Array.isArray(data)) return { outcome: 'failed', detail: 'not_a_list' };

  const rows: WorkspaceDocumentRow[] = [];
  for (const raw of data) {
    const row = parseWorkspaceDocumentRow(raw);
    // Eine unbrauchbare oder fremdartige Zeile wird uebersprungen, nicht repariert.
    if (!row || row.workspaceId !== workspaceId) continue;
    if (row.documentKind !== GENERATED_INVOICE_DOCUMENT_KIND) continue;
    rows.push(row);
  }
  return { outcome: 'synced', rows };
}
