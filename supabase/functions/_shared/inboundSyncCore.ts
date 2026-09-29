/**
 * E-MAIL-07E — Kern des Postfach-Abrufs, ohne Deno- und Supabase-Abhängigkeit.
 *
 * Ablauf je Lauf:
 *   1. Lease holen (`claim`) — parallel laufende Abrufe desselben Postfachs
 *      sind ausgeschlossen; nach einem Fehler mit Wartezeit (Backoff) gibt es
 *      keinen neuen Lease vor Ablauf.
 *   2. Seitenweise Änderungen ab dem gespeicherten Cursor holen (begrenzte
 *      Seitengröße, begrenzte Seitenzahl je Lauf).
 *   3. Jede Nachricht einzeln: laden → Anhänge prüfen/sichern → importieren
 *      (idempotent). Scheitert NUR diese Nachricht, wird das dauerhaft
 *      vermerkt und der Lauf geht weiter.
 *   4. Erst wenn eine Seite vollständig verarbeitet ist, wird der Cursor
 *      fortgeschrieben. Ein Abbruch mitten in der Seite wiederholt beim
 *      nächsten Lauf genau diese Seite — Dubletten verhindert der Import.
 *   5. Abschluss: verbunden bzw. Fehler mit sicherer Kategorie und Wartezeit.
 *
 * Es wird nie gesendet, nie geantwortet. Logs enthalten keine Adressen,
 * Betreffe, Inhalte, Dateinamen oder Zugangsdaten.
 */
import {
  attachmentContentMatchesType,
  fileExtension,
  mimeTypeForExtension,
  sanitizeAttachmentFilename,
} from './emailMessageRules.ts';
import { InboundProviderError, type InboundMailProvider, type NormalizedInboundMessage } from './inboundMailProvider.ts';

export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const INBOUND_ATTACHMENTS_PER_MESSAGE = 50;
export const INBOUND_BATCH_SIZE = 25;
export const INBOUND_MAX_PAGES_PER_RUN = 8;
/** 07E: Mindestabstand zwischen zwei manuellen Abrufen desselben Postfachs. */
export const MANUAL_SYNC_COOLDOWN_SECONDS = 10;

/**
 * Verbleibende Wartezeit (ganze Sekunden, 0 = sofort möglich) seit dem letzten
 * Abrufversuch. Schützt gegen schnell hintereinander ausgelöste Abrufe; parallele
 * Läufe verhindert zusätzlich der Lease.
 */
export function manualSyncCooldownRemaining(lastAttemptAt: string | null | undefined, nowMs: number, seconds = MANUAL_SYNC_COOLDOWN_SECONDS): number {
  const last = lastAttemptAt ? Date.parse(lastAttemptAt) : Number.NaN;
  if (!Number.isFinite(last)) return 0;
  const remainingMs = last + seconds * 1000 - nowMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export interface MailboxConnectionRow {
  id: string;
  workspace_id: string;
  provider_type: string;
  mailbox_address: string;
  status: string;
  sync_cursor: unknown;
  sync_lease_token?: string | null;
  /** Anmeldeart laut Provider-Register (z. B. microsoft_graph: application | delegated). */
  auth_mode?: 'application' | 'delegated' | null;
  /** Quelle, auf die der Abruf begrenzt ist: Ordner (Microsoft) bzw. Label (Gmail). */
  mailbox_source_kind?: 'folder' | 'label' | null;
  mailbox_source_name?: string | null;
  mailbox_source_id?: string | null;
  /** Untergrenze: ältere Nachrichten werden nie importiert. */
  import_from?: string | null;
}

/** Liegt die Eingangszeit vor der Import-Untergrenze? Unbekannte Zeit gilt als „nicht davor". */
export function isBeforeImportFloor(receivedAt: string | undefined | null, importFrom: string | undefined | null): boolean {
  if (!importFrom || !receivedAt) return false;
  const floor = Date.parse(importFrom);
  const received = Date.parse(receivedAt);
  return Number.isFinite(floor) && Number.isFinite(received) && received < floor;
}

export interface StoredInboundAttachment {
  filename: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
}

export interface SkippedInboundAttachment {
  filename: string;
  mime_type: string;
  size_bytes: number;
  reason: 'type_not_allowed' | 'too_large' | 'content_mismatch' | 'too_many' | 'empty' | 'unavailable';
}

export interface InboundSyncDeps {
  claim(connectionId: string): Promise<{ claimed: boolean; connection: MailboxConnectionRow }>;
  createProvider(connection: MailboxConnectionRow): Promise<InboundMailProvider>;
  advanceCursor(connectionId: string, leaseToken: string, cursor: unknown): Promise<void>;
  finish(connectionId: string, leaseToken: string, result: { status: 'connected' | 'error'; category?: string; code?: string; message?: string; retryAfterSeconds?: number }): Promise<void>;
  importMessage(connectionId: string, leaseToken: string, message: Record<string, unknown>, attachments: StoredInboundAttachment[], skipped: SkippedInboundAttachment[]): Promise<{ outcome: 'imported' | 'duplicate' }>;
  recordFailure(connectionId: string, leaseToken: string, providerMessageId: string, errorCode: string): Promise<void>;
  /** Legt die Datei im privaten Bucket ab (`{workspace}/{sha256}.{endung}`); vorhandene Datei = Erfolg. */
  storeAttachment(path: string, bytes: Uint8Array, mimeType: string): Promise<boolean>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  log(entry: Record<string, string | number | boolean | null>): void;
  batchSize?: number;
  maxPages?: number;
}

export type InboundSyncOutcome =
  | { ok: true; action: 'synced'; imported: number; duplicates: number; failed: number; skippedOld: number; pages: number; more: boolean }
  | { ok: true; action: 'busy' | 'backoff' | 'disconnected' }
  | { ok: false; action: 'provider_error'; category: string; code: string };

const SAFE_MESSAGES: Record<string, string> = {
  auth: 'Die Anmeldung beim Postfach ist abgelaufen. Bitte erneut verbinden.',
  reauthorize: 'Die Verbindung zum Postfach muss neu autorisiert werden.',
  rate_limited: 'Der Postfach-Anbieter bittet um eine Pause. Der Abruf wird später fortgesetzt.',
  network: 'Das Postfach war nicht erreichbar. Der Abruf wird später fortgesetzt.',
  provider: 'Der Postfach-Anbieter hat den Abruf nicht beantwortet. Der Abruf wird später fortgesetzt.',
  unknown: 'Beim Abruf ist ein unerwarteter Fehler aufgetreten.',
};

/** 07E-MSA-FIX1: Ordner-Schutz — eindeutige Meldung statt allgemeiner Anbieterstörung. */
const FOLDER_MESSAGES: Record<string, string> = {
  graph_folder_missing: 'Es ist kein Importordner festgelegt. Es wurde nichts gelesen.',
  graph_folder_not_allowed: 'Dieser Ordner ist als Importquelle nicht erlaubt (nur „OfficeTakt-Test"). Es wurde nichts gelesen.',
  graph_folder_system: 'Ein Microsoft-Systemordner (z. B. Posteingang) darf nie Importquelle sein. Es wurde nichts gelesen.',
  graph_folder_not_found: 'Der Ordner „OfficeTakt-Test" wurde im Postfach nicht gefunden. Bitte in Outlook anlegen. Es wurde nichts gelesen.',
  graph_folder_ambiguous: 'Es gibt mehrere Ordner „OfficeTakt-Test". Bitte nur einen behalten. Es wurde nichts gelesen.',
  graph_folder_changed: 'Der gespeicherte Importordner existiert nicht mehr oder heißt anders. Abruf gestoppt — bitte neu verbinden.',
  graph_folder_moved: 'Der Importordner wurde verschoben (z. B. in „Gelöschte Elemente"). Abruf gestoppt.',
  graph_folder_unverifiable: 'Der Importordner konnte nicht sicher geprüft werden. Es wurde nichts gelesen.',
};

export function safeInboundErrorMessage(category: string, code?: string): string {
  if (code && FOLDER_MESSAGES[code]) return FOLDER_MESSAGES[code];
  return SAFE_MESSAGES[category] ?? SAFE_MESSAGES.unknown;
}

/** Anhänge prüfen und sichern; nie ausführbar, nie öffentlich, Name nie als Pfad. */
async function prepareAttachments(
  workspaceId: string,
  message: NormalizedInboundMessage,
  deps: Pick<InboundSyncDeps, 'storeAttachment' | 'sha256Hex'>,
): Promise<{ stored: StoredInboundAttachment[]; skipped: SkippedInboundAttachment[] }> {
  const stored: StoredInboundAttachment[] = [];
  const skipped: SkippedInboundAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of message.attachments) {
    // Eingebettete Bilder (Signaturlogos etc.) sind Teil des Mailtexts, keine Dateien.
    if (attachment.inline && attachment.mimeType.startsWith('image/')) continue;
    const display = attachment.filename.slice(0, 200);
    const safeName = sanitizeAttachmentFilename(attachment.filename);
    const extension = safeName ? fileExtension(safeName) : '';
    const mimeType = mimeTypeForExtension(extension);
    const base = { filename: display, mime_type: attachment.mimeType.slice(0, 120), size_bytes: Math.max(0, Math.round(attachment.size)) };
    if (!safeName || !mimeType) {
      skipped.push({ ...base, reason: 'type_not_allowed' });
      continue;
    }
    if (stored.length >= INBOUND_ATTACHMENTS_PER_MESSAGE) {
      skipped.push({ ...base, reason: 'too_many' });
      continue;
    }
    if (attachment.size > INBOUND_ATTACHMENT_MAX_BYTES) {
      skipped.push({ ...base, reason: 'too_large' });
      continue;
    }
    const bytes = await attachment.loadContent();
    if (!bytes) {
      skipped.push({ ...base, reason: 'unavailable' });
      continue;
    }
    if (bytes.byteLength === 0) {
      skipped.push({ ...base, reason: 'empty' });
      continue;
    }
    if (bytes.byteLength > INBOUND_ATTACHMENT_MAX_BYTES) {
      skipped.push({ ...base, size_bytes: bytes.byteLength, reason: 'too_large' });
      continue;
    }
    if (!attachmentContentMatchesType(bytes, extension)) {
      skipped.push({ ...base, size_bytes: bytes.byteLength, reason: 'content_mismatch' });
      continue;
    }
    const sha256 = await deps.sha256Hex(bytes);
    const key = `${sha256}:${safeName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Pfad nur aus Workspace + Prüfwert + erlaubter Endung — nie aus Provider-Kennung oder Dateiname.
    const path = `${workspaceId}/${sha256}.${extension}`;
    if (!(await deps.storeAttachment(path, bytes, mimeType))) throw new Error('attachment_store_failed');
    stored.push({ filename: safeName, original_filename: display, mime_type: mimeType, size_bytes: bytes.byteLength, sha256, storage_path: path });
  }
  return { stored, skipped };
}

export type ImportInboundOutcome = 'imported' | 'duplicate' | 'skipped_old';

/**
 * Eine normalisierte Nachricht übernehmen: Import-Untergrenze prüfen, Anhänge
 * prüfen/sichern, idempotent importieren. Gemeinsamer Schritt für den
 * Abruf (pull, `runInboundSync`) und einen späteren anbieterunabhängigen
 * Mail-Eingang (push): Der Aufrufer braucht nur Verbindung + gültigen Lease.
 * Wirft bei Fehlern; der Aufrufer entscheidet über Vermerk/Wiederholung.
 */
export async function importInboundMessage(
  connection: Pick<MailboxConnectionRow, 'id' | 'workspace_id' | 'import_from'>,
  lease: string,
  message: NormalizedInboundMessage,
  deps: Pick<InboundSyncDeps, 'importMessage' | 'storeAttachment' | 'sha256Hex'>,
): Promise<ImportInboundOutcome> {
  if (isBeforeImportFloor(message.receivedAt, connection.import_from)) return 'skipped_old';
  const { stored, skipped } = await prepareAttachments(connection.workspace_id, message, deps);
  const result = await deps.importMessage(
    connection.id,
    lease,
    {
      provider_message_id: message.providerMessageId,
      internet_message_id: message.internetMessageId ?? null,
      provider_thread_id: message.providerThreadId ?? null,
      // 07F-01A — Gesprächsverlauf: Zuordnung entscheidet der Server (email_resolve_thread).
      in_reply_to: message.inReplyTo ?? null,
      references: message.references ?? [],
      reply_to: message.replyTo ?? [],
      from_address: message.from?.address ?? null,
      from_name: message.from?.name ?? null,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      body_text: message.bodyText,
      has_html: message.hasHtml,
      received_at: message.receivedAt,
    },
    stored,
    skipped,
  );
  return result.outcome;
}

export async function runInboundSync(connectionId: string, deps: InboundSyncDeps): Promise<InboundSyncOutcome> {
  const claim = await deps.claim(connectionId);
  if (!claim.claimed) {
    const status = claim.connection.status;
    deps.log({ connectionId, outcome: status === 'disconnected' ? 'disconnected' : status === 'syncing' ? 'busy' : 'backoff' });
    return { ok: true, action: status === 'disconnected' ? 'disconnected' : status === 'syncing' ? 'busy' : 'backoff' };
  }
  const connection = claim.connection;
  const lease = String(connection.sync_lease_token ?? '');
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? INBOUND_BATCH_SIZE, 50));
  const maxPages = Math.max(1, deps.maxPages ?? INBOUND_MAX_PAGES_PER_RUN);
  let cursor: unknown = connection.sync_cursor ?? null;
  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  let skippedOld = 0;
  let pages = 0;
  let more = false;
  let cursorResetUsed = false;

  try {
    const provider = await deps.createProvider(connection);
    while (pages < maxPages) {
      let page;
      try {
        page = await provider.listChanges(cursor, batchSize);
      } catch (error) {
        // Abgelaufener Delta-Stand: einmal neu beginnen — Dubletten verhindert der Import.
        if (error instanceof InboundProviderError && error.category === 'cursor_expired' && !cursorResetUsed) {
          cursorResetUsed = true;
          cursor = null;
          continue;
        }
        throw error;
      }
      pages += 1;
      // Diagnose je Seite (nur Zähler/Flags des Adapters, keine Inhalte).
      if (page.stats) deps.log({ connectionId, outcome: 'page', page: pages, ...page.stats });
      for (const item of page.items) {
        // Import-Untergrenze: Delta liefert trotz Filter auch Änderungen an älteren
        // Nachrichten (z. B. gelesen/ungelesen) — die werden nie importiert.
        if (isBeforeImportFloor(item.receivedAt, connection.import_from)) {
          skippedOld += 1;
          continue;
        }
        try {
          const outcome = await importInboundMessage(connection, lease, await item.load(), deps);
          if (outcome === 'imported') imported += 1;
          else if (outcome === 'duplicate') duplicates += 1;
          else skippedOld += 1;
        } catch (error) {
          // Anbieterweite Störung: Seite nicht abschließen, Cursor bleibt stehen.
          if (error instanceof InboundProviderError) throw error;
          failed += 1;
          const code = error instanceof Error && /^[a-z_]{3,48}$/.test(error.message) ? error.message : 'message_processing_failed';
          await deps.recordFailure(connection.id, lease, item.providerMessageId, code);
        }
      }
      // Seite vollständig verarbeitet → Cursor fortschreiben.
      cursor = page.nextCursor;
      await deps.advanceCursor(connection.id, lease, cursor);
      more = page.hasMore;
      if (!page.hasMore) break;
    }
    await deps.finish(connection.id, lease, { status: 'connected', retryAfterSeconds: more ? 1 : undefined });
    deps.log({ connectionId, outcome: 'synced', imported, duplicates, failed, skippedOld, pages, more });
    return { ok: true, action: 'synced', imported, duplicates, failed, skippedOld, pages, more };
  } catch (error) {
    const category = error instanceof InboundProviderError ? (error.category === 'cursor_expired' ? 'provider' : error.category) : 'unknown';
    const code = error instanceof InboundProviderError ? error.code : 'sync_failed';
    const retryAfterSeconds = error instanceof InboundProviderError ? error.retryAfterSeconds : 300;
    await deps.finish(connection.id, lease, { status: 'error', category, code, message: safeInboundErrorMessage(category, code), retryAfterSeconds });
    deps.log({ connectionId, outcome: 'provider_error', category, code, imported, failed, pages });
    return { ok: false, action: 'provider_error', category, code };
  }
}
