/**
 * E-MAIL 07E-AUTO-SYNC 01A — Kern des automatischen Postfachabrufs, ohne
 * Deno- und Supabase-Abhängigkeit.
 *
 * Ein Scheduler-Lauf (pg_cron alle 10 Minuten → Edge Function
 * `mailbox-auto-sync`):
 *   1. Kandidaten laden (nur Steuerdaten, getrennte Postfächer sind schon
 *      ausgeschlossen).
 *   2. Je Postfach entscheiden: fällig oder übersprungen (Anbieter ohne
 *      Adapter, keine Zugangsdaten, „neu verbinden" nötig, aktiver Lease,
 *      Retry-After, Backoff nach Fehlerserie, gerade erst abgerufen).
 *   3. Fällige Postfächer nacheinander über den BESTEHENDEN `runInboundSync`
 *      abrufen — derselbe Lease wie „Jetzt abrufen": läuft dort gerade ein
 *      Abruf, liefert der Claim `busy` und es gibt keinen Anbieter-Aufruf.
 *   4. Eine Log-Zeile pro Lauf mit Zählern — keine Adressen, Betreffe,
 *      Inhalte, Nachrichten-/Ordner-Kennungen, Cursor oder Tokens.
 */
import type { InboundSyncOutcome } from './inboundSyncCore.ts';

/** Zielintervall des pg_cron-Jobs (Minuten); Cron-Ausdruck `*\/10 * * * *`. */
export const AUTO_SYNC_INTERVAL_MINUTES = 10;
/** Nach einem Versuch (z. B. manuell) innerhalb dieser Zeit nicht erneut automatisch abrufen. */
export const AUTO_SYNC_MIN_GAP_SECONDS = 120;
/** Obergrenze des Backoffs nach wiederholten Fehlern. */
export const AUTO_SYNC_MAX_BACKOFF_SECONDS = 6 * 3600;
/** Ab diesem Anteil der Laufzeit werden keine weiteren Postfächer mehr begonnen. */
export const AUTO_SYNC_TIME_BUDGET_MS = 100_000;
/** Toleranz für das Cron-Raster (Läufe kommen nicht sekundengenau). */
const SCHEDULE_TOLERANCE_SECONDS = 60;

export interface AutoSyncCandidateRow {
  id: string;
  provider_type: string;
  auth_mode?: string | null;
  status: string;
  error_category?: string | null;
  has_credential: boolean;
  lease_active: boolean;
  next_attempt_at?: string | null;
  last_attempt_at?: string | null;
  consecutive_failures?: number | null;
}

export type AutoSyncDecision =
  | 'due'
  | 'disconnected'
  | 'provider_unavailable'
  | 'no_credential'
  | 'reconnect_required'
  | 'lease'
  | 'retry_after'
  | 'backoff'
  | 'recent';

/**
 * Wartezeit nach `failures` Fehlversuchen in Folge: der erste Fehler wird beim
 * nächsten Takt erneut versucht (sofern kein Retry-After), danach
 * verdoppelnd ab 20 Minuten bis höchstens 6 Stunden.
 */
export function autoSyncBackoffSeconds(failures: number | null | undefined): number {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  if (n <= 1) return 0;
  return Math.min(AUTO_SYNC_INTERVAL_MINUTES * 60 * 2 ** (n - 1), AUTO_SYNC_MAX_BACKOFF_SECONDS);
}

function timeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function classifyAutoSyncCandidate(row: AutoSyncCandidateRow, nowMs: number, availableProviders: ReadonlySet<string>): AutoSyncDecision {
  if (row.status === 'disconnected') return 'disconnected';
  if (!availableProviders.has(row.provider_type)) return 'provider_unavailable';
  if (!row.has_credential) return 'no_credential';
  // „Neu verbinden" (z. B. invalid_grant): nie automatisch wiederholen, nie automatisch trennen.
  if (row.status === 'error' && row.error_category === 'reauthorize') return 'reconnect_required';
  if (row.lease_active) return 'lease';
  const nextAttempt = timeMs(row.next_attempt_at);
  if (nextAttempt !== null && nextAttempt > nowMs) return 'retry_after';
  const lastAttempt = timeMs(row.last_attempt_at);
  if (lastAttempt !== null) {
    const backoff = row.status === 'error' ? autoSyncBackoffSeconds(row.consecutive_failures) : 0;
    if (backoff > 0 && lastAttempt + (backoff - SCHEDULE_TOLERANCE_SECONDS) * 1000 > nowMs) return 'backoff';
    if (lastAttempt + AUTO_SYNC_MIN_GAP_SECONDS * 1000 > nowMs) return 'recent';
  }
  return 'due';
}

export interface AutoSyncSummary {
  considered: number;
  due: number;
  started: number;
  skippedLease: number;
  skippedBackoff: number;
  skippedRecent: number;
  skippedReconnect: number;
  skippedNoCredential: number;
  skippedProvider: number;
  success: number;
  failure: number;
  imported: number;
  budgetExhausted: boolean;
}

export interface MailboxAutoSyncDeps {
  listCandidates(): Promise<AutoSyncCandidateRow[]>;
  availableProviders: readonly string[];
  /** Genau ein Abruf über den bestehenden `runInboundSync` (inkl. Lease). */
  syncConnection(connectionId: string): Promise<InboundSyncOutcome>;
  log(entry: Record<string, string | number | boolean | null>): void;
  now?: () => number;
  timeBudgetMs?: number;
}

export async function runMailboxAutoSync(deps: MailboxAutoSyncDeps): Promise<AutoSyncSummary> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const budget = deps.timeBudgetMs ?? AUTO_SYNC_TIME_BUDGET_MS;
  const available = new Set(deps.availableProviders);
  const summary: AutoSyncSummary = {
    considered: 0, due: 0, started: 0,
    skippedLease: 0, skippedBackoff: 0, skippedRecent: 0, skippedReconnect: 0, skippedNoCredential: 0, skippedProvider: 0,
    success: 0, failure: 0, imported: 0, budgetExhausted: false,
  };
  const candidates = await deps.listCandidates();
  const due: string[] = [];
  for (const row of candidates) {
    const decision = classifyAutoSyncCandidate(row, startedAt, available);
    if (decision === 'disconnected') continue;
    summary.considered += 1;
    if (decision === 'due') due.push(row.id);
    else if (decision === 'lease') summary.skippedLease += 1;
    else if (decision === 'retry_after' || decision === 'backoff') summary.skippedBackoff += 1;
    else if (decision === 'recent') summary.skippedRecent += 1;
    else if (decision === 'reconnect_required') summary.skippedReconnect += 1;
    else if (decision === 'no_credential') summary.skippedNoCredential += 1;
    else summary.skippedProvider += 1;
  }
  summary.due = due.length;

  for (const connectionId of due) {
    if (now() - startedAt > budget) {
      summary.budgetExhausted = true;
      break;
    }
    try {
      const outcome = await deps.syncConnection(connectionId);
      if (outcome.ok && outcome.action === 'busy') {
        // Manueller Abruf hält gerade den Lease: sauber überspringen, kein Anbieter-Aufruf.
        summary.skippedLease += 1;
      } else if (outcome.ok && outcome.action === 'backoff') {
        summary.skippedBackoff += 1;
      } else if (outcome.ok && outcome.action === 'disconnected') {
        summary.considered -= 1;
      } else if (outcome.ok && outcome.action === 'synced') {
        summary.started += 1;
        summary.success += 1;
        summary.imported += outcome.imported;
      } else {
        summary.started += 1;
        summary.failure += 1;
      }
    } catch {
      summary.started += 1;
      summary.failure += 1;
    }
  }
  deps.log({ outcome: 'run', ...summary, durationMs: Math.max(0, now() - startedAt) });
  return summary;
}
