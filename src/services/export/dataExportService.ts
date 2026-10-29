/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24; D-05 bis D-09; K5) — lesbarer Datenexport: Prüfung, feste Bindung, Laden, ZIP,
 * Download.
 *
 * Ablauf in zwei Schritten, beide abbrechbar (dann ohne Datei):
 *  1. `prepareDataExport` — erfasst Konto, Betrieb und die serverbestätigte Rolle (frische Zugriffsauskunft), prüft die
 *     Warteschlange, holt einen frischen Abzug (nur ohne offene Änderungen: der Export sendet nie selbst), lädt alle
 *     referenzierten Dateien (lokal oder aus der Cloud, ohne den lokalen Bestand zu verändern) und die gesendeten
 *     E-Mails. Ergebnis: die Lückenliste (leer = vollständig) und der geladene Stand.
 *  2. `buildAndDownloadDataExport` — nur ohne Lücken oder mit ausdrücklicher Annahme der Lückenliste; dann heißt die
 *     Datei `…_unvollstaendig.zip`. Stellt das ZIP zusammen und startet den Download nach dem Muster aus AP0.
 * Abzug, jeder Dateiabruf, die Zusammenstellung und der Download prüfen die Bindung; Wechsel von Konto oder Betrieb,
 * Entzug oder Rollenminderung beenden den Export ohne Datei. Späte Antworten des früheren Bereichs werden verworfen.
 * Der Export setzt keinen Abschluss-, Übergabe- oder Exportstatus und umgeht keine Sperre (FINANZ-CORE-01A).
 */
import JSZip from 'jszip';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppPersistedState, CompanyDocument, VorgangInvoice } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { EmailMessage } from '../../types/emailMessage';
import type { Expense, ExpensePayment } from '../../types/expense';
import type { SyncEntityType, SyncOutboxEntry } from '../../types/sync';
import type { EmailMessageListResult, EmailAttachmentDownloadResult } from '../email/emailMessageCloudService';
import {
  buildDataExportCsvFiles,
  DATA_EXPORT_AREA_LABEL,
  type CloudStatus,
  type CloudStatusLookup,
  type DataExportFileEntry,
  type DataExportRole,
} from './dataExportAreas';
import { createZipNameAllocator, sanitizeZipFolderName } from './dataExportFormat';
import { buildDataExportOverviewHtml, buildGapsCsv, type DataExportGap } from './dataExportOverview';
import { buildDataExportFileName, resolveBetriebName } from '../exportFileNames';
import { newestOutboxEntriesByEntity } from '../sync/syncOutboxOrder';
import { buildExpensePaymentEntityId } from '../expense/expenseCloudSyncService';

/** Ab etwa 1 GB warnt die Seite (der Export läuft im Browser; ein Server-Export ist Nachweisgrenze B5). */
export const DATA_EXPORT_SIZE_WARNING_BYTES = 1024 * 1024 * 1024;
/** Die Server-Liste gesendeter E-Mails endet bei 500 Einträgen (neueste zuerst, ohne Fortsetzung). */
export const DATA_EXPORT_EMAIL_LIMIT = 500;
/** Nach so vielen Dateiabrufen fragt der Export die Rolle erneut beim Server ab. */
const ROLE_RECHECK_EVERY_FILES = 50;

export type DataExportPhase = 'binding' | 'pull' | 'check' | 'files' | 'emails' | 'csv' | 'zip' | 'download';

export interface DataExportProgress {
  phase: DataExportPhase;
  done?: number;
  total?: number;
}

export interface DataExportBinding {
  storageKey: string;
  userId: string | null;
  workspaceId: string | null;
  role: DataExportRole;
  cloud: boolean;
  exportedBy: string;
}

interface LoadedFile {
  entry: DataExportFileEntry;
  bytes: Uint8Array | null;
}

export interface DataExportPrepared {
  binding: DataExportBinding;
  gaps: DataExportGap[];
  estimatedBytes: number;
  state: AppPersistedState;
  files: LoadedFile[];
  sentEmails: EmailMessage[];
  attachments: LoadedFile[];
  preparedAt: Date;
}

export type DataExportFailure = 'not_allowed' | 'binding_changed' | 'cancelled' | 'failed';

export type DataExportPrepareResult = { ok: true; prepared: DataExportPrepared } | { ok: false; reason: DataExportFailure };

export type DataExportBuildResult =
  | { ok: true; fileName: string; incomplete: boolean; sizeBytes: number; revokeObjectUrl: () => void }
  | { ok: false; reason: DataExportFailure | 'gaps_not_accepted' };

export interface BoundOperation {
  client: SupabaseClient | null | undefined;
  confirmed: boolean;
  stillValid(): Promise<boolean>;
}

export interface DataExportDeps {
  now(): Date;
  cloudConfigured(): boolean;
  storageKey(): string;
  account(): { userId: string | null; email: string };
  workspaceId(): string | null;
  /** Bindet an den Bereich beim Start (`bindDirectOperation`); `null` = schon gewechselt. */
  bind(startStorageKey: string): Promise<BoundOperation | null>;
  /** Frische Zugriffsauskunft vom Server (Rolle). */
  refreshRole(client: SupabaseClient | null | undefined): Promise<'owner' | 'admin' | 'member' | null>;
  /** Die zuletzt bestätigte Rolle (ohne Netz), für die Prüfung vor jedem Dateiabruf. */
  currentRole(): 'owner' | 'admin' | 'member' | null;
  /** Lokaler Betrieb bzw. Inhaber/Admin nach der Schreibauskunft der Oberfläche (E9). */
  localExportAllowed(): boolean;
  outbox(): SyncOutboxEntry[];
  isHeld(entry: SyncOutboxEntry): boolean;
  cloudSyncAllowed(entityType: SyncEntityType): boolean;
  /** Abgleich (senden und abziehen); wird nur ohne offene Änderungen aufgerufen, sendet also nichts. */
  pull(): Promise<'ok' | 'failed' | 'scope_changed'>;
  snapshot(): AppPersistedState;
  lastPersistOk(): boolean;
  fileRefs(): DocumentFileRef[];
  bindings(): DocumentFileRepresentationBinding[];
  readLocalFile(ref: DocumentFileRef): Promise<Blob | null>;
  downloadCloudFile(ref: DocumentFileRef, client: SupabaseClient | null | undefined): Promise<Uint8Array>;
  listSentEmails(workspaceId: string, client: SupabaseClient | null | undefined): Promise<EmailMessageListResult>;
  downloadEmailAttachment(
    input: { storagePath: string; mimeType: string; storageBucket?: 'email-attachments' | 'inbound-email-attachments' },
    client: SupabaseClient | null | undefined,
  ): Promise<EmailAttachmentDownloadResult>;
  unconfirmedInvoicePayments(): ReadonlySet<string>;
  unconfirmedFinance(state: AppPersistedState, outbox: SyncOutboxEntry[], cloud: boolean): DataExportGap[];
  invoiceNetCents(invoice: VorgangInvoice): number | null;
  invoiceOpenAmount(invoice: VorgangInvoice): number;
  documentFolder(document: CompanyDocument, state: AppPersistedState): string;
  download(blob: Blob, fileName: string): { revoke: () => void };
}

class Abbruch extends Error {
  constructor(readonly reason: DataExportFailure) {
    super(reason);
  }
}

interface Kontext {
  deps: DataExportDeps;
  binding: DataExportBinding;
  bound: BoundOperation | null;
  signal?: AbortSignal;
}

function abgebrochen(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Abbruch('cancelled');
}

/** Gilt die Bindung noch? Ohne Netz: Bereich, Betrieb, Rolle; mit `server`: dazu eine frische Zugriffsauskunft. */
async function pruefeBindung(ctx: Kontext, server = false): Promise<void> {
  abgebrochen(ctx.signal);
  const { deps, binding } = ctx;
  if (deps.storageKey() !== binding.storageKey || deps.workspaceId() !== binding.workspaceId) throw new Abbruch('binding_changed');
  if (!binding.cloud) {
    if (!deps.localExportAllowed()) throw new Abbruch('binding_changed');
    return;
  }
  if (!ctx.bound || !(await ctx.bound.stillValid())) throw new Abbruch('binding_changed');
  const rolle = server ? await deps.refreshRole(ctx.bound.client) : deps.currentRole();
  // Späte Antwort: erst nach der Rückfrage erneut den Bereich prüfen.
  if (deps.storageKey() !== binding.storageKey || deps.workspaceId() !== binding.workspaceId) throw new Abbruch('binding_changed');
  if (rolle !== 'owner' && rolle !== 'admin') throw new Abbruch('binding_changed');
  if (rolle !== binding.role) throw new Abbruch('binding_changed');
  abgebrochen(ctx.signal);
}

function outboxStand(deps: DataExportDeps): {
  open: number;
  rejected: number;
  held: number;
  unconfirmed: Set<string>;
} {
  // Es zählt der jüngste Auftrag je Datensatz (Einreihungsnummer), wie überall in der Warteschlange.
  const newest = newestOutboxEntriesByEntity(deps.outbox());
  let open = 0;
  let rejected = 0;
  let held = 0;
  const unconfirmed = new Set<string>();
  for (const [key, entry] of newest) {
    if (!deps.cloudSyncAllowed(entry.entityType)) continue;
    if (entry.status === 'completed') continue;
    unconfirmed.add(key);
    if (deps.isHeld(entry)) held += 1;
    else if (entry.status === 'failed') rejected += 1;
    else open += 1;
  }
  return { open, rejected, held, unconfirmed };
}

function cloudLookup(binding: DataExportBinding, unconfirmed: Set<string>, unconfirmedPayments: ReadonlySet<string>): CloudStatusLookup {
  const lokal = (): CloudStatus => 'local';
  if (!binding.cloud) {
    return { entity: lokal, invoice: lokal, invoicePayment: lokal, expensePayment: lokal };
  }
  return {
    entity: (entityType, id) => (unconfirmed.has(`${entityType}:${id}`) ? 'unconfirmed' : 'confirmed'),
    invoice: (invoice) => (invoice.status === 'entwurf' ? 'unconfirmed' : 'confirmed'),
    invoicePayment: (invoice, paymentId) => {
      const payment = (invoice.payments ?? []).find((p) => p.id === paymentId);
      return unconfirmedPayments.has(`${invoice.id}#${paymentId}`) || payment?.cloudBestaetigt !== true ? 'unconfirmed' : 'confirmed';
    },
    expensePayment: (expense: Expense, payment: ExpensePayment) =>
      unconfirmed.has(`expense_payment:${buildExpensePaymentEntityId(expense.id, payment.id)}`) || unconfirmed.has(`expense:${expense.id}`)
        ? 'unconfirmed'
        : 'confirmed',
  };
}

/** Die Dateien der Dokumente: Original und gespeicherte Darstellungen (Archiv, strukturiert), nie Vorschauen. */
function referenzierteDateien(state: AppPersistedState, deps: DataExportDeps): Array<{ document: CompanyDocument; ref: DocumentFileRef | null; fileRefId: string; role: string }> {
  const refs = new Map(deps.fileRefs().map((ref) => [ref.id, ref]));
  const bindings = deps.bindings();
  const ergebnis: Array<{ document: CompanyDocument; ref: DocumentFileRef | null; fileRefId: string; role: string }> = [];
  for (const document of (state.documents ?? []).filter((d) => !d.sync?.deleted)) {
    const gesehen = new Set<string>();
    const add = (fileRefId: string | undefined, role: string) => {
      if (!fileRefId || gesehen.has(fileRefId)) return;
      gesehen.add(fileRefId);
      ergebnis.push({ document, ref: refs.get(fileRefId) ?? null, fileRefId, role });
    };
    add(document.fileRefId, 'original');
    for (const binding of bindings.filter((b) => b.documentId === document.id)) {
      if (binding.kind === 'archive' || binding.kind === 'structured') add(binding.fileRefId, binding.kind);
    }
  }
  return ergebnis;
}

async function ladeDatei(ctx: Kontext, ref: DocumentFileRef): Promise<Uint8Array | null> {
  const { deps } = ctx;
  if (ref.storageType !== 'cloud') {
    // Lokal (Daten-URL bzw. IndexedDB): ohne Nebenwirkung auf den Bestand.
    const blob = await deps.readLocalFile(ref).catch(() => null);
    if (blob) return new Uint8Array(await blob.arrayBuffer());
  }
  if (!ctx.binding.cloud || !ref.cloud?.storagePath || !ctx.bound) return null;
  // Aus der Cloud nur in den Speicher des Exports — keine Übernahme in den lokalen Bestand.
  return deps.downloadCloudFile(ref, ctx.bound.client).catch(() => null);
}

export async function prepareDataExport(
  deps: DataExportDeps,
  options: { signal?: AbortSignal; onProgress?: (progress: DataExportProgress) => void } = {},
): Promise<DataExportPrepareResult> {
  const melde = options.onProgress ?? (() => undefined);
  try {
    melde({ phase: 'binding' });
    const cloud = deps.cloudConfigured();
    const startKey = deps.storageKey();
    const account = deps.account();
    const workspaceId = deps.workspaceId();
    if (!deps.localExportAllowed()) return { ok: false, reason: 'not_allowed' };

    let bound: BoundOperation | null = null;
    let role: DataExportRole = 'local';
    if (cloud) {
      bound = await deps.bind(startKey);
      if (!bound || !bound.confirmed || !workspaceId) return { ok: false, reason: 'binding_changed' };
      const serverRolle = await deps.refreshRole(bound.client);
      if (deps.storageKey() !== startKey || deps.workspaceId() !== workspaceId) return { ok: false, reason: 'binding_changed' };
      if (serverRolle !== 'owner' && serverRolle !== 'admin') return { ok: false, reason: 'not_allowed' };
      role = serverRolle;
    }
    const binding: DataExportBinding = { storageKey: startKey, userId: account.userId, workspaceId, role, cloud, exportedBy: account.email };
    const ctx: Kontext = { deps, binding, bound, signal: options.signal };
    await pruefeBindung(ctx);

    const gaps: DataExportGap[] = [];
    // 1 — Warteschlange dieses Betriebs (D-05.1).
    let stand = outboxStand(deps);
    // 2 — frischer Abzug in dieser Sitzung (D-05.8); der Export sendet nie selbst.
    if (cloud) {
      if (stand.open > 0) {
        gaps.push({ kind: 'pull_skipped', area: 'Synchronisation', description: 'Kein frischer Abzug: Zuerst müssen die offenen Änderungen abgeglichen werden (Seite Synchronisation).' });
      } else {
        melde({ phase: 'pull' });
        const pull = await deps.pull();
        if (pull === 'scope_changed') throw new Abbruch('binding_changed');
        await pruefeBindung(ctx, true);
        if (pull === 'failed') gaps.push({ kind: 'pull_failed', area: 'Synchronisation', description: 'Der aktuelle Stand konnte nicht vollständig vom Server geladen werden.' });
        stand = outboxStand(deps);
      }
    }
    melde({ phase: 'check' });
    if (stand.open > 0) gaps.push({ kind: 'sync_open', area: 'Synchronisation', description: `${stand.open} Änderung(en) warten auf den Abgleich mit der Cloud.`, count: stand.open });
    if (stand.rejected > 0) gaps.push({ kind: 'sync_rejected', area: 'Synchronisation', description: `${stand.rejected} Änderung(en) wurden vom Server abgewiesen.`, count: stand.rejected });
    if (stand.held > 0) gaps.push({ kind: 'sync_held', area: 'Synchronisation', description: `${stand.held} Änderung(en) werden zurückgehalten (Herkunft ungeklärt).`, count: stand.held });
    if (!deps.lastPersistOk()) gaps.push({ kind: 'persist_failed', area: 'Gerät', description: 'Das letzte Speichern auf diesem Gerät ist gescheitert; der Stand im Speicher ist nicht gesichert.' });

    const state = deps.snapshot();
    // Finanzzustände (D-05.7): offen, abgewiesen oder unbestätigt — benannt, nie umgangen.
    gaps.push(...deps.unconfirmedFinance(state, deps.outbox(), cloud));

    // 3 — Dateien (D-05.2): lokal oder herunterladbar; jede fehlende steht in der Lückenliste.
    const dateien = referenzierteDateien(state, deps);
    const vergib = createZipNameAllocator();
    const files: LoadedFile[] = [];
    let estimatedBytes = 0;
    for (let index = 0; index < dateien.length; index += 1) {
      const { document, ref, fileRefId, role: dateiRolle } = dateien[index];
      melde({ phase: 'files', done: index, total: dateien.length });
      await pruefeBindung(ctx, cloud && index > 0 && index % ROLE_RECHECK_EVERY_FILES === 0);
      const bytes = ref ? await ladeDatei(ctx, ref) : null;
      // Späte Antwort nach einem Wechsel: verwerfen, nicht aufnehmen (D-05.6).
      await pruefeBindung(ctx);
      const originalName = ref?.originalFileName || document.originalFileName || document.title || fileRefId;
      const folder = deps.documentFolder(document, state);
      const entry: DataExportFileEntry = {
        documentId: document.id,
        fileRefId,
        role: dateiRolle,
        originalName,
        zipPath: bytes ? vergib(folder, originalName) : null,
        sizeBytes: bytes?.byteLength ?? ref?.fileSize ?? 0,
        mimeType: ref?.mimeType ?? 'application/octet-stream',
      };
      estimatedBytes += entry.sizeBytes;
      files.push({ entry, bytes });
      if (!bytes) {
        gaps.push({ kind: 'file_unavailable', area: 'Dokumente', description: `Datei nicht verfügbar: ${originalName} (Dokument „${document.title}“)`, reference: fileRefId });
      }
    }
    melde({ phase: 'files', done: dateien.length, total: dateien.length });

    // Gesendete E-Mails (Serverstand) mit Anhängen.
    const sentEmails: EmailMessage[] = [];
    const attachments: LoadedFile[] = [];
    if (cloud && workspaceId && bound) {
      melde({ phase: 'emails' });
      const liste = await deps.listSentEmails(workspaceId, bound.client);
      await pruefeBindung(ctx);
      if (!liste.ok) {
        gaps.push({ kind: 'emails_unavailable', area: 'Gesendete E-Mails', description: 'Die gesendeten E-Mails konnten nicht vom Server geladen werden.' });
      } else {
        sentEmails.push(...liste.messages.filter((message) => message.direction !== 'inbound'));
        if (liste.messages.length >= DATA_EXPORT_EMAIL_LIMIT) {
          gaps.push({ kind: 'emails_truncated', area: 'Gesendete E-Mails', description: `Der Server liefert höchstens die ${DATA_EXPORT_EMAIL_LIMIT} neuesten gesendeten E-Mails; ältere fehlen in diesem Export.` });
        }
        const folder = `dateien/${sanitizeZipFolderName('emails')}`;
        const anhaenge = sentEmails.flatMap((message) => (message.attachments ?? []).map((attachment) => ({ message, attachment })));
        for (let index = 0; index < anhaenge.length; index += 1) {
          const { message, attachment } = anhaenge[index];
          melde({ phase: 'emails', done: index, total: anhaenge.length });
          await pruefeBindung(ctx, index > 0 && index % ROLE_RECHECK_EVERY_FILES === 0);
          const result = await deps.downloadEmailAttachment(
            { storagePath: attachment.storagePath, mimeType: attachment.mimeType, storageBucket: attachment.storageBucket },
            bound.client,
          );
          await pruefeBindung(ctx);
          const bytes = result.ok ? new Uint8Array(await result.blob.arrayBuffer()) : null;
          const originalName = attachment.originalFilename || attachment.filename;
          const entry: DataExportFileEntry = {
            documentId: message.id,
            fileRefId: attachment.id ?? `${message.id}#${attachment.position}`,
            role: 'email_attachment',
            originalName,
            zipPath: bytes ? vergib(folder, originalName) : null,
            sizeBytes: bytes?.byteLength ?? attachment.sizeBytes ?? 0,
            mimeType: attachment.mimeType,
          };
          estimatedBytes += entry.sizeBytes;
          attachments.push({ entry, bytes });
          if (!bytes) {
            gaps.push({ kind: 'file_unavailable', area: 'Gesendete E-Mails', description: `Anhang nicht verfügbar: ${originalName} (E-Mail „${message.subject}“)`, reference: entry.fileRefId });
          }
        }
      }
    }
    await pruefeBindung(ctx);
    return {
      ok: true,
      prepared: { binding, gaps, estimatedBytes, state, files, sentEmails, attachments, preparedAt: deps.now() },
    };
  } catch (error) {
    if (error instanceof Abbruch) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'failed' };
  }
}

export async function buildAndDownloadDataExport(
  deps: DataExportDeps,
  prepared: DataExportPrepared,
  options: { acceptGaps: boolean; signal?: AbortSignal; onProgress?: (progress: DataExportProgress) => void },
): Promise<DataExportBuildResult> {
  const melde = options.onProgress ?? (() => undefined);
  const incomplete = prepared.gaps.length > 0;
  // Nie still unvollständig: Lücken nur mit ausdrücklicher Annahme.
  if (incomplete && !options.acceptGaps) return { ok: false, reason: 'gaps_not_accepted' };
  const ctx: Kontext = {
    deps,
    binding: prepared.binding,
    bound: prepared.binding.cloud ? await deps.bind(prepared.binding.storageKey) : null,
    signal: options.signal,
  };
  try {
    await pruefeBindung(ctx, prepared.binding.cloud);
    melde({ phase: 'csv' });
    const when = deps.now();
    const betrieb = resolveBetriebName(prepared.state);
    const fileName = buildDataExportFileName(betrieb, when, { incomplete });
    const outbox = outboxStand(deps);
    const csvFiles = buildDataExportCsvFiles({
      state: prepared.state,
      sentEmails: prepared.sentEmails,
      role: prepared.binding.role,
      lookup: cloudLookup(prepared.binding, outbox.unconfirmed, deps.unconfirmedInvoicePayments()),
      files: [...prepared.files, ...prepared.attachments].map((file) => file.entry),
      invoiceNetCents: deps.invoiceNetCents,
      invoiceOpenAmount: deps.invoiceOpenAmount,
    });
    const alleDateien = [...prepared.files, ...prepared.attachments];
    const zip = new JSZip();
    for (const file of csvFiles) zip.file(file.path, file.content);
    zip.file('luecken.csv', buildGapsCsv(prepared.gaps));
    for (const file of alleDateien) {
      if (file.bytes && file.entry.zipPath) zip.file(file.entry.zipPath, file.bytes);
    }
    zip.file(
      'uebersicht.html',
      buildDataExportOverviewHtml({
        betrieb,
        workspaceId: prepared.binding.workspaceId,
        exportedAt: when,
        exportedBy: prepared.binding.exportedBy,
        role: prepared.binding.role,
        cloud: prepared.binding.cloud,
        incomplete,
        areas: csvFiles.map((file) => ({ label: DATA_EXPORT_AREA_LABEL[file.area], path: file.path, rows: file.rows })),
        files: {
          referenced: alleDateien.length,
          included: alleDateien.filter((file) => file.bytes && file.entry.zipPath).length,
          missing: alleDateien.filter((file) => !file.bytes).length,
        },
        gaps: prepared.gaps,
        fileName,
      }),
    );
    abgebrochen(options.signal);
    melde({ phase: 'zip', done: 0, total: 100 });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, (meta) => {
      melde({ phase: 'zip', done: Math.round(meta.percent), total: 100 });
    });
    // Zusammenstellung fertig: vor dem Download noch einmal Bereich und serverbestätigte Rolle.
    await pruefeBindung(ctx, prepared.binding.cloud);
    melde({ phase: 'download' });
    const { revoke } = deps.download(blob, fileName);
    return { ok: true, fileName, incomplete, sizeBytes: blob.size, revokeObjectUrl: revoke };
  } catch (error) {
    if (error instanceof Abbruch) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'failed' };
  }
}
