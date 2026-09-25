/**
 * FINANZ-SYNC-BLOCKER-01B — der Monatsabschluss in der Cloud.
 *
 * Ein Abschluss ist **keine Zeile, die man überschreibt**, sondern eine Folge
 * von Handlungen: abschliessen, später vielleicht wieder öffnen. Der Server
 * bildet genau das ab — `close_workspace_accounting_period` legt eine Revision
 * an, `reopen_workspace_accounting_period` markiert sie als wieder geöffnet.
 * Ein generisches Upsert gibt es dort bewusst nicht; es könnte die
 * Revisionshistorie gar nicht erzeugen.
 *
 * Deshalb entscheidet **nicht** die Outbox-Operation (`create`/`update`), was
 * gesendet wird, sondern der lokale Zustand des Abschlusses. Das ist der Kern:
 * Wird ein Monat lokal abgeschlossen und wieder geöffnet, **bevor** je ein Sync
 * lief, verschmilzt die Outbox beides zu einem einzigen `update`. Ein blosses
 * Reopen liefe dann am Server ins Leere — es gäbe nichts zu öffnen. Aus dem
 * lokalen Stand lässt sich dagegen beides ableiten, und die Cloud bekommt
 * dieselbe Historie: Revision angelegt, danach geöffnet.
 *
 * Die Aufrufe sind einzeln wiederholbar. Ein Replay nach Verbindungsabbruch
 * erzeugt weder eine zweite Revision (der Server erkennt denselben Fingerprint)
 * noch einen Fehler beim erneuten Öffnen.
 */
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import { getSupabaseClient } from '../../lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';

function client(explicit?: SupabaseClient | null): SupabaseClient {
  const resolved = explicit ?? getSupabaseClient();
  if (!resolved) throw new WorkspaceCloudError('Supabase ist nicht konfiguriert.', 'unknown', false);
  return resolved;
}

/**
 * Serverfehler einordnen.
 *
 * Die inhaltlichen Abschlussregeln (`period_…`, `closure_…`) sind Urteile über
 * die Daten: Derselbe Aufruf scheitert beim nächsten Mal genauso. Ohne diese
 * Einstufung liefe der Sync endlos weiter — dieselbe Falle wie bei der
 * Geldintegrität in 05B2.
 */
export function classifyPeriodCloudError(error: {
  message?: string;
  code?: string;
}): WorkspaceCloudError {
  const message = error.message ?? 'Unbekannter Cloud-Fehler';
  if (message.includes('Nicht angemeldet')) return new WorkspaceCloudError(message, 'auth', false);
  if (message.includes('Kein Zugriff') || error.code === '42501') {
    return new WorkspaceCloudError(message, 'rls', false);
  }
  if (message.includes('Versionskonflikt')) {
    return new WorkspaceCloudError(message, 'version_conflict', false);
  }
  if (message.includes('period_') || message.includes('closure_')) {
    return new WorkspaceCloudError(message, 'unknown', false);
  }
  if (message.includes('Failed to fetch') || message.includes('Network')) {
    return new WorkspaceCloudError(message, 'network', true);
  }
  return new WorkspaceCloudError(message, 'unknown', true);
}

/** `2026-07` zu Jahr und Monat; `null`, wenn der Schlüssel nicht stimmt. */
export function parseMonthKey(monthKey: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Was der Server zum Abschliessen braucht.
 *
 * Fingerprint und Manifest sind der Kern des Nachweises und gehen unverändert
 * mit. `sync` bleibt draussen — Gerätewissen gehört nicht in den Abschluss.
 */
export function buildAccountingPeriodClosePayload(
  closure: AccountingPeriodClosure,
): Record<string, unknown> {
  const period = parseMonthKey(closure.monthKey);
  return {
    client_closure_id: closure.id,
    period_year: period?.year ?? null,
    period_month: period?.month ?? null,
    fingerprint: closure.fingerprint,
    manifest: closure.manifest,
  };
}

export interface ClosureRpcResult {
  revision: number;
  rowVersion: number;
  noop: boolean;
}

export async function rpcCloseWorkspaceAccountingPeriod(
  workspaceId: string,
  payload: Record<string, unknown>,
  explicit?: SupabaseClient | null,
): Promise<ClosureRpcResult> {
  const { data, error } = await client(explicit).rpc('close_workspace_accounting_period', {
    p_workspace_id: workspaceId,
    p_payload: payload,
  });
  if (error) throw classifyPeriodCloudError(error);
  return {
    revision: Number(data?.revision ?? 0),
    rowVersion: Number(data?.row_version ?? 0),
    noop: Boolean(data?.noop),
  };
}

export async function rpcReopenWorkspaceAccountingPeriod(
  workspaceId: string,
  year: number,
  month: number,
  reason: string | null,
  expectedRevision: number | null,
  explicit?: SupabaseClient | null,
): Promise<{ revision: number; rowVersion: number }> {
  const { data, error } = await client(explicit).rpc('reopen_workspace_accounting_period', {
    p_workspace_id: workspaceId,
    p_period_year: year,
    p_period_month: month,
    p_reason: reason,
    p_expected_revision: expectedRevision,
  });
  if (error) throw classifyPeriodCloudError(error);
  return { revision: Number(data?.revision ?? 0), rowVersion: Number(data?.row_version ?? 0) };
}

/** Die Schritte, die ein Push tatsächlich ausgeführt hat — für Tests und Report. */
export type ClosurePushStep = 'close' | 'close_noop' | 'reopen' | 'reopen_noop';

export type ClosurePushOutcome =
  | { kind: 'pushed'; rowVersion: number; revision: number; steps: ClosurePushStep[] }
  | { kind: 'skipped'; reason: string };

/**
 * Bringt den Server auf denselben Stand wie den lokalen Abschluss.
 *
 * Abgeleitet wird aus zwei Angaben:
 *
 *   - `rowVersion > 0` heisst, dieser Abschluss war schon einmal erfolgreich in
 *     der Cloud. Dann existiert die Revision dort und muss nicht erneut
 *     angelegt werden.
 *   - `reopenedAt` heisst, der Monat ist lokal wieder offen. Dann muss er es am
 *     Ende auch remote sein.
 *
 * Daraus ergeben sich genau die drei Fälle, die der Abnahmelauf gezeigt hat:
 * nur abschliessen, nur öffnen — und beides hintereinander, wenn lokal
 * geschlossen und wieder geöffnet wurde, ohne dass dazwischen ein Sync lief.
 */
export async function pushAccountingPeriodClosure(
  closure: AccountingPeriodClosure,
  rowVersion: number,
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<ClosurePushOutcome> {
  const period = parseMonthKey(closure.monthKey);
  if (!period) return { kind: 'skipped', reason: 'invalid_month_key' };

  const steps: ClosurePushStep[] = [];
  let version = rowVersion;
  let revision = closure.revision;

  if (rowVersion <= 0) {
    const closed = await rpcCloseWorkspaceAccountingPeriod(
      workspaceId,
      buildAccountingPeriodClosePayload(closure),
      explicit,
    );
    steps.push(closed.noop ? 'close_noop' : 'close');
    version = closed.rowVersion;
    /*
     * Die Revisionsnummer kommt vom Server, nicht aus dem lokalen Stand. Hatte
     * die Cloud für diesen Monat bereits ältere Revisionen, vergibt sie eine
     * andere Nummer als der Client — und das anschliessende Öffnen muss die
     * treffen, die gerade entstanden ist.
     */
    revision = closed.revision || revision;
  }

  if (closure.reopenedAt) {
    try {
      const reopened = await rpcReopenWorkspaceAccountingPeriod(
        workspaceId,
        period.year,
        period.month,
        closure.reopenReason ?? null,
        revision,
        explicit,
      );
      steps.push('reopen');
      version = reopened.rowVersion;
    } catch (error) {
      /*
       * „Kein offener Abschluss" heisst hier: Der Server ist bereits dort, wo
       * der Client ihn haben will. Das passiert, wenn die Antwort auf ein
       * früheres Öffnen verloren ging. Ein Fehler wäre das nur dem Namen nach —
       * und würde den Auftrag dauerhaft festhalten.
       */
      if (error instanceof WorkspaceCloudError && error.message.includes('period_not_closed')) {
        steps.push('reopen_noop');
      } else {
        throw error;
      }
    }
  }

  return { kind: 'pushed', rowVersion: version, revision, steps };
}

/** Übernimmt die Serverversion nach einem erfolgreichen Push. */
export function applyAccountingPeriodPushResultToState(
  closures: AccountingPeriodClosure[],
  id: string,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): AccountingPeriodClosure[] {
  return closures.map((item) => {
    if (item.id !== id) return item;
    const sync: SyncMeta = {
      ...(item.sync ?? {}),
      version: rowVersion,
      updatedAt,
      updatedBy: deviceId,
      workspaceId,
    } as SyncMeta;
    return { ...item, sync };
  });
}

/* -------------------------------------------------------------------------- */
/* Abschluesse lesen                                                           */
/* -------------------------------------------------------------------------- */

/**
 * FINANZ-SYNC-BLOCKER-01C — eine Abschlusszeile, wie der Server sie liefert.
 *
 * `created_at` und `updated_at` stehen bewusst als optional: Die vorhandene
 * Lesefunktion gibt sie nicht zurück. Sie sind fuer den fachlichen Stand auch
 * nicht noetig — ein Abschluss traegt seinen Zeitpunkt in `closed_at` und seine
 * Aenderung in `reopened_at`. Deshalb wird dafuer **keine** zusaetzliche
 * Migration aufgemacht; die beiden Felder werden sauber abgeleitet, und falls
 * ein spaeterer Server sie doch mitschickt, gewinnen seine Werte.
 */
export interface CloudAccountingPeriodRow {
  client_closure_id: string;
  period_year: number;
  period_month: number;
  revision: number;
  fingerprint: string;
  manifest: Record<string, unknown>;
  closed_at: string;
  closed_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  reopen_reason: string | null;
  row_version: number;
  created_at?: string;
  updated_at?: string;
}

export interface AccountingPeriodCloudPull {
  closures: CloudAccountingPeriodRow[];
}

export async function rpcPullWorkspaceAccountingPeriodClosures(
  workspaceId: string,
  explicit?: SupabaseClient | null,
): Promise<AccountingPeriodCloudPull> {
  const { data, error } = await client(explicit).rpc(
    'pull_workspace_accounting_period_closures',
    { p_workspace_id: workspaceId },
  );
  if (error) throw classifyPeriodCloudError(error);
  return { closures: (data?.closures ?? []) as CloudAccountingPeriodRow[] };
}

export interface AccountingPeriodPullContext {
  readonly deviceId: string;
  readonly workspaceId: string;
}

function monthKeyFrom(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Eine Cloud-Zeile in eine Abschlussrevision uebersetzen.
 *
 * Vollstaendig: Monat, Revision, Abschlusszeitpunkt und -person, Fingerprint,
 * Manifest **und** die Oeffnungsspur. Ohne `reopenedAt` haette ein zweites
 * Geraet einen Monat als geschlossen gesehen, den jemand laengst wieder
 * geoeffnet hat — und der Export haette ihn freigegeben.
 */
export function rowToAccountingPeriodClosure(
  row: CloudAccountingPeriodRow,
  context?: AccountingPeriodPullContext,
): AccountingPeriodClosure {
  const manifest = (row.manifest ?? {}) as Record<string, unknown>;
  const monthKey = monthKeyFrom(row.period_year, row.period_month);
  return {
    id: row.client_closure_id,
    monthKey,
    revision: Number(row.revision),
    closedAt: row.closed_at,
    closedBy: row.closed_by ?? undefined,
    fingerprint: row.fingerprint,
    manifest: {
      monthKey: (manifest.monthKey as string) ?? monthKey,
      chartOfAccounts: (manifest.chartOfAccounts as string) ?? '',
      documentCount: Number(manifest.documentCount ?? 0),
      totalBrutto: Number(manifest.totalBrutto ?? 0),
      totalNetto: Number(manifest.totalNetto ?? 0),
      totalSteuer: Number(manifest.totalSteuer ?? 0),
      entries: Array.isArray(manifest.entries)
        ? (manifest.entries as AccountingPeriodClosure['manifest']['entries'])
        : [],
    },
    reopenedAt: row.reopened_at ?? undefined,
    reopenedBy: row.reopened_by ?? undefined,
    reopenReason: row.reopen_reason ?? undefined,
    /*
     * Abgeleitet, nicht erfunden: Angelegt wurde die Revision mit ihrem
     * Abschluss; zuletzt geaendert wurde sie beim Wiederoeffnen, sonst nie.
     */
    createdAt: row.created_at ?? row.closed_at,
    updatedAt: row.updated_at ?? row.reopened_at ?? row.closed_at,
    sync: {
      updatedAt: row.updated_at ?? row.reopened_at ?? row.closed_at,
      version: Number(row.row_version),
      deleted: false,
      deviceId: context?.deviceId ?? '',
      workspaceId: context?.workspaceId ?? '',
    } as SyncMeta,
  };
}

export interface AccountingPeriodMergeResult {
  closures: AccountingPeriodClosure[];
  conflicts: string[];
  counts: { added: number; updated: number; keptLocal: number };
}

/**
 * Cloud-Historie mit dem lokalen Bestand zusammenfuehren.
 *
 * Zwei Eigenheiten gegenueber einem gewoehnlichen Merge:
 *
 *   1. **Es wird nichts entfernt.** Der Server kennt fuer Abschluesse keinen
 *      Grabstein, und eine lokale Revision, die die Cloud noch nicht hat, ist
 *      fast immer eine, die gerade erst entstanden ist. Sie zu loeschen hiesse,
 *      einen Nachweis zu verlieren, bevor er uebertragen wurde.
 *   2. **Alle Revisionen kommen an, nicht nur die aktive.** Die Lesefunktion
 *      liefert die vollstaendige Historie eines Monats; genau die braucht die
 *      Revisionsanzeige und der Export.
 *
 * Eine lokal noch nicht uebertragene Revision gewinnt und wird als Konflikt
 * gemeldet, statt still ueberschrieben zu werden.
 */
export function mergeAccountingPeriodClosuresFromPull(
  local: AccountingPeriodClosure[],
  pull: AccountingPeriodCloudPull,
  dirtyKeys: ReadonlySet<string> = new Set(),
  context?: AccountingPeriodPullContext,
): AccountingPeriodMergeResult {
  const byId = new Map(local.map((item) => [item.id, item]));
  const conflicts: string[] = [];
  const counts = { added: 0, updated: 0, keptLocal: 0 };

  for (const row of pull.closures ?? []) {
    const id = row.client_closure_id;
    const existing = byId.get(id);

    if (dirtyKeys.has(id)) {
      if (existing) counts.keptLocal += 1;
      conflicts.push(id);
      continue;
    }

    byId.set(id, rowToAccountingPeriodClosure(row, context));
    if (existing) counts.updated += 1;
    else counts.added += 1;
  }

  /*
   * Kanonisch sortiert: Monat absteigend, innerhalb eines Monats die neueste
   * Revision zuerst. Ohne feste Ordnung haette derselbe Stand je nach
   * Reihenfolge des Pulls eine andere Darstellung.
   */
  const closures = [...byId.values()].sort((a, b) =>
    a.monthKey === b.monthKey ? b.revision - a.revision : b.monthKey.localeCompare(a.monthKey),
  );

  return { closures, conflicts, counts };
}

/** Die Abschluesse, deren lokale Aenderung noch unterwegs ist. */
export function collectDirtyAccountingPeriodKeys(
  outbox: SyncOutboxEntry[] | undefined,
): Set<string> {
  const dirty = new Set<string>();
  for (const entry of outbox ?? []) {
    if (entry.status !== 'pending' && entry.status !== 'error' && entry.status !== 'blocked') continue;
    if (entry.entityType === 'accounting_period_closure') dirty.add(entry.entityId);
  }
  return dirty;
}
