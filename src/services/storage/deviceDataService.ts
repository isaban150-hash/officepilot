/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.29, K6; X-05; Abschluss 22 zu WEISS E-13) — „Daten auf diesem Gerät“: Bestände des
 * Kontos ansehen und entfernen.
 *
 * Produktentscheidung (27.10.2026): Nicht synchronisierte Daten werden nicht entfernt, solange ihre tatsächliche
 * Wiederherstellbarkeit nicht nachgewiesen ist. Im Cloud-Betrieb gibt es keinen nachgewiesenen Weg, eine Sicherungsdatei
 * zurückzuspielen (`restoreLocalBackupBundle` lehnt dort ab; D-04.1 ist zurückgestellt). Deshalb schalten weder eine
 * Sicherung noch eine Bestätigung das Entfernen frei — es gibt dafür keinen Parameter mehr. Entfernt wird nur, wenn kein
 * Bestand dieses Kontos auf diesem Gerät etwas trägt, das nur hier liegen kann:
 *  - `unsynced`: offene (ausstehend, blockiert, wiederholbar) oder abgewiesene Aufträge; Rechnungszahlungen ohne
 *    Serverbestätigung und abgewiesene Zahlungen; Vermerke „nicht bestätigt“ und Nachsicherungssperren; begonnene
 *    Rechnungsfreigaben und Nachtragsbestätigungen (Ausgang unbekannt);
 *  - `not_verified`: für den Betriebsbestand ist in dieser Sitzung kein vollständiger Abgleich ohne offene Aufträge
 *    nachgewiesen, oder der Bestand hat sich seitdem geändert. Erst ein Abgleich reiht Altbestand ein, den die Cloud
 *    nicht kennt; ohne ihn sähe ein abgebrochener Abgleich wie ein abgeschlossener aus;
 *  - `unreadable`: ein Bestand oder eine Nebenablage lässt sich nicht lesen (nicht prüfbar);
 *  - `local_only`: Daten, die nie abgeglichen werden — Geschäftsdaten im Kontobereich ohne Betrieb, früherer Mailimport;
 *  - `draft`: Entwürfe nur auf diesem Gerät — ein Rechnungsentwurf, dessen Stand nicht gespiegelt ist, ein unbestätigter
 *    Upload, Entwürfe von Kundenzuordnung, Versand und Einrichtung;
 *  - `check_failed`: die lokalen Entwurfsspeicher (IndexedDB) ließen sich nicht prüfen oder sind noch nicht geprüft.
 *
 * Nicht gezählt: das Firmen-Gedächtnis (Dokumentgedächtnis, Nachweise, Relationen) — eine Ableitung, die beim Laden
 * aus den abgeglichenen Daten neu entsteht (`rebuildOfficePilotMemoryProjection`); zwischengespeicherte Dateien und Logos
 * (ihr Hochladen ist ein eigener Auftrag `document_file` bzw. Teil des Firmenprofils); der Sitzungsspeicher des Tabs.
 *
 * Ablauf: andere Tabs dieses Kontos erhalten eine Nachricht, melden sich lokal ab und geben ihre Sitzungssperre frei;
 * unter der exklusiven Sperre dieses Kontos wird erneut geprüft (laufender und gespeicherter Stand), dann lokal
 * abgemeldet (beendet Hintergrund-Sync, Abrufe und späte Antworten) und der gespeicherte Stand ein letztes Mal geprüft —
 * diese Prüfungen liegen im Dienst und lassen sich über die Abhängigkeiten nicht abschalten. Scheitert eine, wird nichts
 * entfernt. Serverdaten bleiben unverändert.
 */
import { buildBusinessContentFingerprint, buildPersistedStateSnapshot } from '../persistenceService';
import { buildInvoiceDraftCoreKey, buildInvoiceDraftCoreKeyFromDraft } from '../invoice/invoiceDraftCloudService';
import { newestOutboxEntriesByEntity } from '../sync/syncOutboxOrder';
import { getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftCloudCore } from '../../types/invoiceDraftCloud';
import type { SyncOutboxEntry } from '../../types/sync';
import { getActiveStorageKey, STORAGE_KEY_PREFIX } from './storageScopeService';
import {
  inventoryLocalAccountData,
  readLocalAccountDrafts,
  removeLocalAccountData,
  type LocalAccountDrafts,
  type LocalAccountRemovalResult,
} from './localAccountDataService';

export interface DeviceWorkspaceData {
  workspaceId: string;
  storageKey: string;
  name: string;
  bytes: number;
  savedAt: string | null;
  openChanges: number;
  rejectedChanges: number;
  role: 'owner' | 'admin' | 'member' | null;
}

export interface DeviceDataInventory {
  workspaces: DeviceWorkspaceData[];
  /** Kontobereich ohne Betrieb (`officepilot-state:user:<konto>`), falls auf diesem Gerät vorhanden. */
  accountArea: { storageKey: string; bytes: number } | null;
  otherAccounts: number;
}

export interface DeviceBackupRecord {
  userId: string;
  workspaceId: string;
  fileName: string;
  createdAt: string;
  complete: boolean;
  fingerprint: string;
}

const BACKUP_REGISTRY_KEY = 'officetakt.deviceBackups';
const SYNC_VERIFIED_KEY = 'officetakt.deviceSyncVerified';
const ACCESS_KEY_PREFIX = 'officetakt-workspace-access:';

function parseState(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readItem(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Offene (ausstehend, Konflikt, wiederholbar) und abgewiesene Aufträge je jüngstem Auftrag eines Datensatzes. */
export function deviceOutboxCounts(outbox: unknown): { open: number; rejected: number; digest: string } {
  const entries = Array.isArray(outbox) ? (outbox as SyncOutboxEntry[]) : [];
  let open = 0;
  let rejected = 0;
  const teile: string[] = [];
  for (const [key, entry] of newestOutboxEntriesByEntity(entries)) {
    if (entry.status === 'completed') continue;
    if (entry.status === 'failed') rejected += 1;
    else open += 1;
    teile.push(`${key}:${entry.status}:${entry.version}`);
  }
  return { open, rejected, digest: teile.sort().join('|') };
}

/** Änderungsstand eines Betriebsbestands: fachlicher Inhalt und nicht abgeschlossene Aufträge. */
export function deviceDataFingerprint(state: object): string {
  const record = state as Record<string, unknown>;
  return `${buildBusinessContentFingerprint(state)}#${deviceOutboxCounts(record.syncOutbox).digest}`;
}

function roleOf(userId: string, workspaceId: string): DeviceWorkspaceData['role'] {
  const record = parseState(readItem(`${ACCESS_KEY_PREFIX}${userId}:${workspaceId}`));
  const role = record?.role;
  return role === 'owner' || role === 'admin' || role === 'member' ? role : null;
}

function accountAreaKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}:user:${userId}`;
}

/** Die Bestände dieses Kontos auf diesem Gerät; andere Konten nur als Anzahl. */
export function inspectDeviceData(userId: string): DeviceDataInventory {
  const inventory = inventoryLocalAccountData(userId);
  const workspaces = inventory.workspaces.map((entry): DeviceWorkspaceData => {
    const state = parseState(readItem(entry.storageKey));
    const counts = deviceOutboxCounts(state?.syncOutbox);
    const workspace = state?.workspace as { name?: string } | undefined;
    const profile = state?.companyProfile as { companyName?: string } | undefined;
    return {
      workspaceId: entry.workspaceId,
      storageKey: entry.storageKey,
      name: workspace?.name?.trim() || profile?.companyName?.trim() || '',
      bytes: entry.bytes,
      savedAt: typeof state?.savedAt === 'string' ? state.savedAt : null,
      openChanges: counts.open,
      rejectedChanges: counts.rejected,
      role: roleOf(userId, entry.workspaceId),
    };
  });
  const accountRaw = readItem(accountAreaKey(userId));
  return {
    workspaces,
    accountArea: accountRaw === null ? null : { storageKey: accountAreaKey(userId), bytes: accountRaw.length * 2 },
    otherAccounts: inventory.otherAccounts,
  };
}

function readRegistry<T extends { userId: string }>(key: string): T[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(value) ? (value as T[]).filter((entry) => entry && typeof entry.userId === 'string') : [];
  } catch {
    return [];
  }
}

function writeRegistry<T>(key: string, entries: T[]): void {
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(entries));
  } catch {
    // Ohne Sitzungsspeicher gibt es keinen Nachweis — Entfernen bleibt dann gesperrt.
  }
}

/**
 * Nach einer Sicherung in dieser Sitzung (Tab): die jüngste je Konto und Betrieb. Nur zur Anzeige — eine Sicherung
 * schaltet das Entfernen nie frei (E-13).
 */
export function recordDeviceBackup(record: DeviceBackupRecord): void {
  const rest = readRegistry<DeviceBackupRecord>(BACKUP_REGISTRY_KEY).filter(
    (entry) => !(entry.userId === record.userId && entry.workspaceId === record.workspaceId),
  );
  writeRegistry(BACKUP_REGISTRY_KEY, [...rest, record]);
}

export function getDeviceBackup(userId: string, workspaceId: string): DeviceBackupRecord | null {
  return readRegistry<DeviceBackupRecord>(BACKUP_REGISTRY_KEY).find((entry) => entry.userId === userId && entry.workspaceId === workspaceId) ?? null;
}

export interface DeviceSyncVerification {
  userId: string;
  storageKey: string;
  /** `deviceDataFingerprint` des gespeicherten Bestands unmittelbar nach dem Abgleich. */
  fingerprint: string;
  verifiedAt: string;
}

/**
 * Ein vollständiger Abgleich dieses Bestands ist in dieser Sitzung gelungen, und danach blieb kein offener oder
 * abgewiesener Auftrag. Gilt nur, solange sich der gespeicherte Bestand nicht ändert.
 */
export function recordDeviceSyncVerification(record: DeviceSyncVerification): void {
  const rest = readRegistry<DeviceSyncVerification>(SYNC_VERIFIED_KEY).filter(
    (entry) => !(entry.userId === record.userId && entry.storageKey === record.storageKey),
  );
  writeRegistry(SYNC_VERIFIED_KEY, [...rest, record]);
}

export function getDeviceSyncVerification(userId: string, storageKey: string): DeviceSyncVerification | null {
  return readRegistry<DeviceSyncVerification>(SYNC_VERIFIED_KEY).find((entry) => entry.userId === userId && entry.storageKey === storageKey) ?? null;
}

/** Warum ein Bestand dieses Kontos nicht entfernt werden darf (siehe Kopf). */
export type DeviceRemovalBlock = 'unsynced' | 'not_verified' | 'unreadable' | 'local_only' | 'draft' | 'check_failed';

const BLOCK_ORDER: readonly DeviceRemovalBlock[] = ['unsynced', 'unreadable', 'local_only', 'draft', 'not_verified', 'check_failed'];

export interface DeviceRemovalArea {
  /** Speicherschlüssel des Bestands (Betrieb dieses Kontos oder Kontobereich). */
  storageKey: string;
  /** `null` = Kontobereich ohne Betrieb (oder ein Entwurf ohne zuordenbaren Bestand). */
  workspaceId: string | null;
  name: string;
  /** Alle Gründe, in der Reihenfolge von `BLOCK_ORDER`; der erste ist der angezeigte. */
  reasons: DeviceRemovalBlock[];
}

export interface DeviceRemovalEvaluation {
  allowed: boolean;
  affected: DeviceRemovalArea[];
}

export interface DeviceRemovalInput {
  /** Der laufende Stand des aktiven Bestands — er zählt zusätzlich zum gespeicherten. */
  live?: { storageKey: string; state: object } | null;
  /** Ergebnis der Prüfung der Entwurfsspeicher (`readLocalAccountDrafts`); `null` = noch nicht geprüft. */
  drafts: LocalAccountDrafts | null;
  now?: number;
}

interface DraftMirror {
  id: string;
  draftSha256: string | null;
  coreKey: string | null;
  settled: boolean;
}

interface StateFindings {
  unsynced: number;
  localOnly: number;
  mirrors: DraftMirror[];
}

const ACCOUNT_AREA_COLLECTIONS = [
  'invoiceEntries', 'inboxItems', 'vorgaenge', 'tasks', 'documents', 'uploadedDocuments', 'documentFileRefs',
  'documentWorkResults', 'expenses', 'accountingAssignments', 'accountingPeriodClosures', 'customers', 'vorgangNotes',
  'businessLetters', 'offers', 'orderDrafts', 'bankTransactions', 'bankAccounts', 'bankReconciliations',
  'dunningDocumentations', 'communicationHistory', 'knowledgeFacts', 'employees', 'employeePayments', 'invoiceDrafts',
  'mailImports',
] as const;

/** Geschäftsdaten im Kontobereich ohne Betrieb: Dort wird nichts abgeglichen (vgl. `hasBusinessEntities`). */
function hasAccountAreaBusinessData(state: Record<string, unknown>): boolean {
  const memory = state.officePilotMemory as { paperRegisterEntries?: unknown } | undefined;
  const blobs = state.documentFileBlobs;
  return (
    ACCOUNT_AREA_COLLECTIONS.some((name) => list(state[name]).length > 0) ||
    list(memory?.paperRegisterEntries).length > 0 ||
    Boolean(blobs && typeof blobs === 'object' && Object.keys(blobs).length > 0)
  );
}

function isActive(entity: unknown): boolean {
  return !(entity as { sync?: { deleted?: unknown } } | null)?.sync?.deleted;
}

function invoicesOf(state: Record<string, unknown>): Array<Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>();
  const take = (invoice: unknown) => {
    if (!invoice || typeof invoice !== 'object') return;
    const record = invoice as Record<string, unknown>;
    seen.set(typeof record.id === 'string' ? record.id : `#${seen.size}`, record);
  };
  for (const entry of list(state.invoiceEntries)) take((entry as { invoice?: unknown } | null)?.invoice);
  for (const vorgang of list(state.vorgaenge)) for (const invoice of list((vorgang as { invoices?: unknown } | null)?.invoices)) take(invoice);
  return [...seen.values()];
}

function coreKeyOf(core: unknown): string | null {
  if (!core || typeof core !== 'object') return null;
  try {
    return buildInvoiceDraftCoreKey(core as InvoiceDraftCloudCore);
  } catch {
    return null;
  }
}

function stateFindings(state: Record<string, unknown>): StateFindings {
  const counts = deviceOutboxCounts(state.syncOutbox);
  let payments = 0;
  for (const invoice of invoicesOf(state)) {
    // D4 — im Cloud-Betrieb zählt nur positive Evidenz: ohne `cloudBestaetigt` kennt der Server die Zahlung nicht sicher.
    payments += list(invoice.payments).filter((payment) => (payment as { cloudBestaetigt?: unknown } | null)?.cloudBestaetigt !== true).length;
    payments += list(invoice.rejectedPayments).length;
  }
  const mirrors = list(state.invoiceDrafts).map((value): DraftMirror => {
    const entity = (value ?? {}) as { id?: unknown; core?: unknown; conflict?: unknown; localLink?: { draftSha256?: unknown } };
    return {
      id: typeof entity.id === 'string' ? entity.id : '',
      draftSha256: typeof entity.localLink?.draftSha256 === 'string' ? entity.localLink.draftSha256 : null,
      coreKey: coreKeyOf(entity.core),
      settled: Boolean(entity.core) && !entity.conflict && isActive(entity),
    };
  });
  return {
    unsynced: counts.open + counts.rejected + payments,
    localOnly: list(state.mailImports).filter(isActive).length,
    mirrors,
  };
}

/** Nebenablagen am Bestandsschlüssel, deren Einträge nur auf diesem Gerät stehen. */
const UNSYNCED_SIDECARS = [
  ':invoice-payment-unconfirmed',
  ':invoice-payment-resync-blocks',
  ':invoice-finalize-intents',
  ':order-amendment-confirm-intents',
] as const;
const CUSTOMER_ASSIGNMENT_DRAFT = 'officepilot-customer-assignment-draft:';
const SEND_DRAFT = 'officepilot.sendDraft.v1:';
const SETUP_DRAFT = 'officetakt-setup-draft:';
const AREA_KEY = new RegExp(`^${STORAGE_KEY_PREFIX}:(?:workspace:([^:]+):account:([^:]+):(?:full|member)|user:([^:]+))`);
const SCOPE_KEY = /^(?:workspace:([^:]+):account:([^:]+):(?:full|member)|user:([^:]+))/;

function localKeys(): string[] {
  const keys: string[] = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return keys;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
  } catch {
    return keys;
  }
  return keys;
}

function entryCount(raw: string | null): number | 'unreadable' {
  if (raw === null) return 0;
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Bestandsschlüssel zu einem Speicherbereich (`workspace:<b>:account:<k>:<sicht>` bzw. `user:<k>`) dieses Kontos. */
function areaKeyOfScope(scopeKey: unknown, userId: string): string | null {
  if (typeof scopeKey !== 'string') return null;
  const match = SCOPE_KEY.exec(scopeKey);
  if (!match || (match[2] ?? match[3]) !== userId) return null;
  return `${STORAGE_KEY_PREFIX}:${match[0]}`;
}

function workspaceIdOfArea(storageKey: string): string | null {
  return AREA_KEY.exec(storageKey)?.[1] ?? null;
}

/**
 * Prüft die Voraussetzungen (K6, E-13) für alle Bestände dieses Kontos auf diesem Gerät: gespeicherte Bestände und
 * Nebenablagen, den laufenden Stand des aktiven Bestands und das Ergebnis der Entwurfsprüfung.
 */
export function evaluateDeviceRemoval(userId: string, input: DeviceRemovalInput): DeviceRemovalEvaluation {
  const inventory = inspectDeviceData(userId);
  const names = new Map(inventory.workspaces.map((workspace) => [workspace.storageKey, workspace.name]));
  const reasons = new Map<string, Set<DeviceRemovalBlock>>();
  const add = (storageKey: string, reason: DeviceRemovalBlock) => {
    const set = reasons.get(storageKey) ?? new Set<DeviceRemovalBlock>();
    set.add(reason);
    reasons.set(storageKey, set);
  };
  const mirrors = new Map<string, DraftMirror[]>();
  const apply = (storageKey: string, findings: StateFindings) => {
    if (findings.unsynced > 0) add(storageKey, 'unsynced');
    if (findings.localOnly > 0) add(storageKey, 'local_only');
  };

  for (const workspace of inventory.workspaces) {
    const raw = readItem(workspace.storageKey);
    const state = parseState(raw);
    if (!state) {
      add(workspace.storageKey, 'unreadable');
      continue;
    }
    const findings = stateFindings(state);
    apply(workspace.storageKey, findings);
    mirrors.set(workspace.storageKey, findings.mirrors);
    const verification = getDeviceSyncVerification(userId, workspace.storageKey);
    if (!verification || verification.fingerprint !== deviceDataFingerprint(state)) add(workspace.storageKey, 'not_verified');
  }

  if (inventory.accountArea) {
    const state = parseState(readItem(inventory.accountArea.storageKey));
    if (!state) add(inventory.accountArea.storageKey, 'unreadable');
    else {
      apply(inventory.accountArea.storageKey, stateFindings(state));
      if (hasAccountAreaBusinessData(state)) add(inventory.accountArea.storageKey, 'local_only');
    }
  }

  // Der laufende Stand ist neuer als der gespeicherte: Was dort offen ist, zählt ebenso — und seine Spiegel gelten.
  if (input.live) {
    const findings = stateFindings(input.live.state as Record<string, unknown>);
    apply(input.live.storageKey, findings);
    mirrors.set(input.live.storageKey, findings.mirrors);
  }

  for (const key of localKeys()) {
    if (!key.includes(userId)) continue;
    const sidecar = UNSYNCED_SIDECARS.find((suffix) => key.endsWith(suffix));
    if (sidecar) {
      const area = key.slice(0, -sidecar.length);
      if (!AREA_KEY.test(area)) continue;
      const count = entryCount(readItem(key));
      if (count === 'unreadable') add(area, 'unreadable');
      else if (count > 0) add(area, 'unsynced');
      continue;
    }
    if (key.startsWith(CUSTOMER_ASSIGNMENT_DRAFT)) {
      const area = AREA_KEY.exec(key.slice(CUSTOMER_ASSIGNMENT_DRAFT.length))?.[0];
      add(area ?? accountAreaKey(userId), 'draft');
      continue;
    }
    if (key.startsWith(SEND_DRAFT)) {
      add(areaKeyOfScope(key.slice(SEND_DRAFT.length), userId) ?? accountAreaKey(userId), 'draft');
      continue;
    }
    if (key.startsWith(`${SETUP_DRAFT}${userId}`)) {
      const workspaceId = key.slice(`${SETUP_DRAFT}${userId}:`.length);
      const area = workspaceId ? inventory.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.storageKey : undefined;
      add(area ?? accountAreaKey(userId), 'draft');
    }
  }

  const drafts = input.drafts;
  if (!drafts || !drafts.ok) add(accountAreaKey(userId), 'check_failed');
  if (drafts) {
    const now = input.now ?? Date.now();
    for (const record of drafts.invoiceDrafts) {
      const area = areaKeyOfScope(record.sourceScopeKey, userId) ?? accountAreaKey(userId);
      if (record.status === 'finalized') continue;
      if (record.status === 'finalizing') {
        add(area, 'unsynced');
        continue;
      }
      const mirror = (mirrors.get(area) ?? []).find((entry) => entry.id === record.draftId);
      let gespiegelt = false;
      if (mirror?.settled) {
        if (mirror.draftSha256 !== null && mirror.draftSha256 === record.draftSha256) gespiegelt = true;
        else if (mirror.coreKey !== null && typeof record.draftRawJson === 'string') {
          try {
            gespiegelt = mirror.coreKey === buildInvoiceDraftCoreKeyFromDraft(JSON.parse(record.draftRawJson) as InvoiceDraft);
          } catch {
            gespiegelt = false;
          }
        }
      }
      if (!gespiegelt) add(area, 'draft');
    }
    for (const record of drafts.uploadDrafts) {
      const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : Number.NaN;
      // Abgelaufene Upload-Entwürfe haben ihre vorgesehene Lebensdauer erreicht (24 h) und werden nicht mehr fortgesetzt.
      if (!Number.isNaN(expiresAt) && expiresAt <= now) continue;
      add(areaKeyOfScope(record.scopeKey, userId) ?? accountAreaKey(userId), 'draft');
    }
  }

  const affected = [...reasons.entries()]
    .map(([storageKey, set]): DeviceRemovalArea => ({
      storageKey,
      workspaceId: workspaceIdOfArea(storageKey),
      name: names.get(storageKey) ?? '',
      reasons: BLOCK_ORDER.filter((reason) => set.has(reason)),
    }))
    .sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  return { allowed: affected.length === 0, affected };
}

/** Die Prüfung am gespeicherten Stand, einschließlich der Entwurfsspeicher (ohne laufenden Stand). */
export async function evaluateStoredDeviceRemoval(userId: string): Promise<DeviceRemovalEvaluation> {
  const drafts = await readLocalAccountDrafts(userId).catch((): LocalAccountDrafts => ({ ok: false, invoiceDrafts: [], uploadDrafts: [] }));
  return evaluateDeviceRemoval(userId, { drafts });
}

/** Der laufende Stand des aktiven Bestands dieses Kontos (mit der aktuellen Warteschlange); `null` für andere Bereiche. */
export function deviceLiveState(userId: string): { storageKey: string; state: object } | null {
  const storageKey = getActiveStorageKey();
  if (!storageKey.includes(userId)) return null;
  return { storageKey, state: { ...buildPersistedStateSnapshot(), syncOutbox: getSyncOutboxSnapshot() } };
}

export interface AccountDeletionDeviceState {
  /** Belegtes Risiko: etwas liegt nachweislich nicht in der Cloud, oder der Bestand lässt sich nicht prüfen. */
  risiko: DeviceRemovalArea[];
  /** Nur unklar: nichts Offenes erkannt, aber in dieser Sitzung kein vollständiger Abgleich nachgewiesen. */
  unklar: DeviceRemovalArea[];
}

/**
 * Abschluss 23/24 (Entscheidungen zu Bericht 22 und 23) — für die Kontolöschung: die Bestände dieses Kontos auf diesem
 * Gerät, getrennt nach belegtem Risiko (deutliche Warnung vor Datenverlust) und bloß unklarem Abgleich (`not_verified`
 * allein: sachlicher, neutraler Hinweis — kein Datenverlust behauptet). Die Kontolöschung entfernt die Daten danach vom
 * Gerät; sie wird gewarnt bzw. hingewiesen, aber nie gesperrt (Art. 17 DSGVO). Nur dieses Konto: Bestände anderer Konten
 * werden weder gelesen noch genannt.
 */
export async function assessAccountDeletionDeviceRisk(userId: string): Promise<AccountDeletionDeviceState> {
  const drafts = await readLocalAccountDrafts(userId).catch((): LocalAccountDrafts => ({ ok: false, invoiceDrafts: [], uploadDrafts: [] }));
  const bewertung = evaluateDeviceRemoval(userId, { live: deviceLiveState(userId), drafts });
  const belegt = (area: DeviceRemovalArea) => area.reasons.some((reason) => reason !== 'not_verified');
  return {
    risiko: bewertung.affected.filter(belegt),
    unklar: bewertung.affected.filter((area) => !belegt(area)),
  };
}

/** Fingerabdruck eines gespeicherten Bestands (andere als der aktive Betrieb). */
export function storedDeviceFingerprint(storageKey: string): string | null {
  const state = parseState(readItem(storageKey));
  return state ? deviceDataFingerprint(state) : null;
}

export const DEVICE_REMOVAL_CHANNEL = 'officetakt-device-data';
export const accountLockName = (userId: string) => `officetakt-account:${userId}`;

export type DeviceRemovalOutcome =
  | { ok: true; result: LocalAccountRemovalResult }
  | { ok: false; reason: 'other_tabs' | 'failed' }
  /** Eine Prüfung unter der Sperre hat gesperrt; `loggedOut`: erst nach der Abmeldung (nichts entfernt). */
  | { ok: false; reason: 'blocked'; loggedOut: boolean; evaluation: DeviceRemovalEvaluation };

export interface DeviceRemovalDeps {
  /** Gibt die eigene geteilte Sitzungssperre frei (danach darf die exklusive greifen). */
  releaseOwnLock(): void;
  /** Hält die eigene Sitzungssperre wieder (wenn das Entfernen nicht stattfindet). */
  reacquireOwnLock(): void;
  logoutLocal(): Promise<void>;
  broadcast(message: { type: 'device-data-removal'; userId: string }): void;
  exclusiveLock<T>(name: string, timeoutMs: number, run: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
  remove(userId: string): Promise<LocalAccountRemovalResult>;
  /** Der laufende Stand des aktiven Bestands, unmittelbar vor der Abmeldung (zusätzlich zum gespeicherten). */
  live?(): { storageKey: string; state: object } | null;
}

/**
 * Entfernt die Daten dieses Kontos von diesem Gerät: Nachricht an die anderen Tabs, eigene Sitzungssperre frei, dann
 * unter der exklusiven Sperre prüfen, lokal abmelden, erneut prüfen und entfernen. Melden sich andere Tabs nicht binnen
 * `timeoutMs` ab, bleibt alles unverändert (weiter angemeldet, kein Entfernen). Sperrt eine Prüfung, wird nichts entfernt.
 */
export async function removeDeviceData(userId: string, deps: DeviceRemovalDeps, timeoutMs = 15_000): Promise<DeviceRemovalOutcome> {
  deps.broadcast({ type: 'device-data-removal', userId });
  deps.releaseOwnLock();
  try {
    const lauf = await deps.exclusiveLock(accountLockName(userId), timeoutMs, async (): Promise<DeviceRemovalOutcome> => {
      const drafts = await readLocalAccountDrafts(userId).catch((): LocalAccountDrafts => ({ ok: false, invoiceDrafts: [], uploadDrafts: [] }));
      const vorher = evaluateDeviceRemoval(userId, { live: deps.live?.() ?? null, drafts });
      if (!vorher.allowed) return { ok: false, reason: 'blocked', loggedOut: false, evaluation: vorher };
      await deps.logoutLocal();
      const nachher = await evaluateStoredDeviceRemoval(userId);
      if (!nachher.allowed) return { ok: false, reason: 'blocked', loggedOut: true, evaluation: nachher };
      return { ok: true, result: await deps.remove(userId) };
    });
    if (!lauf.acquired) {
      deps.reacquireOwnLock();
      return { ok: false, reason: 'other_tabs' };
    }
    if (!lauf.value.ok && lauf.value.reason === 'blocked' && !lauf.value.loggedOut) deps.reacquireOwnLock();
    return lauf.value;
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Die echten Wege des Browsers (Web Locks, BroadcastChannel); ohne Web Locks entfernt der Tab nach kurzer Wartezeit. */
export async function browserExclusiveLock<T>(
  name: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { acquired: true, value: await run() };
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const value = await locks.request(name, { mode: 'exclusive', signal: abort.signal }, async () => {
      clearTimeout(timer);
      return run();
    });
    return { acquired: true, value: value as T };
  } catch (error) {
    if (abort.signal.aborted) return { acquired: false };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Entfernt nur, wenn die Prüfung am gespeicherten Stand es erlaubt (Schutz auch für Aufrufe ohne die Seite). */
export async function defaultDeviceRemove(userId: string): Promise<LocalAccountRemovalResult> {
  const pruefung = await evaluateStoredDeviceRemoval(userId);
  if (!pruefung.allowed) throw new Error('device_data_unsynced');
  return removeLocalAccountData(userId);
}

/** Der gespeicherte Bestand eines Betriebs dieses Kontos (für Tests und die Seite). */
export function deviceStorageKey(workspaceId: string, userId: string, access: 'full' | 'member'): string {
  return `${STORAGE_KEY_PREFIX}:workspace:${workspaceId}:account:${userId}:${access}`;
}
