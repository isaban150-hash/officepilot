/**
 * FINANZ-CORE-01A (ZAH-02) — lokal erfasste, nie gesicherte Rechnungszahlungen
 * automatisch nachsichern.
 *
 * Eine Zahlung wird zuerst lokal gebucht und danach in die Cloud gesendet
 * (PAYMENT-CLOUD-DURABILITY-04B2B). Scheiterte das Senden — offline, Netz weg —,
 * blieb sie bisher nur auf diesem Gerät, bis jemand die Rechnung öffnete und
 * „Sichern" drückte. Die anderen Geräte hielten die Rechnung so lange für offen;
 * eine zweite Erfassung derselben Überweisung oder eine Mahnung waren die Folge.
 *
 * Hier geschieht dasselbe wie beim Knopf, nur ohne ihn:
 *
 *   - Grundlage ist ein **vollständiger** Abzug aller Cloud-Zahlungen samt
 *     Grabsteinen. Unbekannt ist nur, was dort gar nicht vorkommt; eine in der
 *     Cloud stornierte Zahlung wird nie wiederbelebt.
 *   - Gesendet wird die vorhandene Zahlung mit ihrer Kennung — der Server
 *     behandelt eine Wiederholung als Replay, nie als zweite Zahlung.
 *   - Stornierte Rechnungen bleiben aussen vor; der Server nähme dort keine
 *     Zahlung an (ZAH-19 bleibt ein eigener Befund).
 *   - Ein Lauf frühestens alle zehn Minuten; ein gescheiterter Versand wird
 *     frühestens nach diesem Abstand wiederholt — sofort, wenn die Oberfläche
 *     gerade selbst einen Versand scheitern sah (`markInvoicePaymentResyncNeeded`).
 *
 * FINANZ-CORE-01A (WEISS-Nacharbeit N01) — eine **endgültige** Abweisung bleibt
 * endgültig, auch über einen Neustart hinweg. Bisher stand sie nur im
 * Arbeitsspeicher (`deniedThisSession`, `conflicted`): Nach einem Neustart sandte
 * der Dienst dieselbe alte Zahlung erneut — und nach einem Rechtewechsel nahm der
 * Server sie an, ohne dass jemand sie neu bestätigt hatte. Jetzt gilt:
 *
 *   - Endgültig sind Rollen-/Kontoabweisung (`denied`), Datenkonflikt
 *     (`conflict`), unbestätigte Überzahlung (`overpayment_unconfirmed`) und
 *     stornierte Rechnung (`invoice_cancelled`). Sie werden je Betrieb
 *     (Speicherbereich) und Zahlung dauerhaft auf dem Gerät vermerkt.
 *   - Eine Rollenabweisung gilt für alle Zahlungen, die in diesem Moment
 *     ungesichert waren — der Server prüft die Person, nicht die Zahlung. Eine
 *     danach bewusst neu erfasste Zahlung ist davon nicht betroffen.
 *   - Aufgehoben wird ein Vermerk nur durch eine bewusste neue Handlung: „Sichern"
 *     an der Zahlung oder die Bestätigung einer Überzahlung
 *     (`releaseInvoicePaymentResyncConflict`).
 *   - Netz- und Serverfehler (`failed`, fehlende Konfiguration) bleiben flüchtig
 *     und werden nach dem Abstand wiederholt.
 *
 * Lokal wird an Zahlungen nichts verändert. Der Hinweis „noch nicht gesichert"
 * nennt den Grund eines Vermerks (`getInvoicePaymentResyncBlocks`).
 */
import type { InvoicePayment, VorgangInvoice } from '../../types/models';
import { isFinalizedInvoice } from '../invoiceArchiveService';
import { getInvoicePayments, isInvoiceCancelled, syncInvoicePaymentToCloud } from '../invoicePaymentService';
import { getActiveStorageKey } from '../storage/storageScopeService';
import { listInvoices } from './invoiceRegistryService';
import type { SyncSchedulerStatus } from '../sync/syncScheduler';
import {
  pullInvoicePaymentsFromCloud,
  type InvoicePaymentCloudOutcome,
  type InvoicePaymentCloudPullResult,
} from './workspaceInvoicePaymentCloudService';

const MIN_INTERVAL_MS = 10 * 60 * 1000;

/** Endgültige Ausgänge: Ein neuer automatischer Versuch ändert an ihnen nichts. */
export type InvoicePaymentResyncBlockReason = 'denied' | 'conflict' | 'overpayment_unconfirmed' | 'invoice_cancelled';

const FINAL_OUTCOMES: ReadonlySet<InvoicePaymentCloudOutcome> = new Set<InvoicePaymentCloudOutcome>([
  'denied',
  'conflict',
  'overpayment_unconfirmed',
  'invoice_cancelled',
]);

export function isFinalInvoicePaymentResyncOutcome(
  outcome: InvoicePaymentCloudOutcome,
): outcome is InvoicePaymentResyncBlockReason {
  return FINAL_OUTCOMES.has(outcome);
}

export interface InvoicePaymentResyncReport {
  skipped?: 'throttled' | 'denied_earlier' | 'pull_failed';
  candidates: number;
  synced: number;
  failed: number;
  denied: boolean;
  /** WEISS-N01 — wegen eines dauerhaften Vermerks übergangene Zahlungen. */
  blocked?: number;
}

export interface InvoicePaymentResyncDeps {
  now?: () => number;
  listInvoices?: () => VorgangInvoice[];
  pull?: () => Promise<InvoicePaymentCloudPullResult>;
  push?: (invoiceId: string, payment: InvoicePayment) => Promise<InvoicePaymentCloudOutcome>;
}

let lastRunAt: number | null = null;
/** Nur eine Abkürzung für diese Sitzung; maßgeblich sind die dauerhaften Vermerke. */
let deniedThisSession = false;
let inFlight: Promise<InvoicePaymentResyncReport> | null = null;
/** Gescheiterte Versände und ihr Zeitpunkt — Wiederholung frühestens nach dem Abstand (flüchtig). */
const failedAt = new Map<string, number>();

function key(invoiceId: string, paymentId: string): string {
  return `${invoiceId}#${paymentId}`;
}

/* ------------------------------------------------------------------ */
/* Dauerhafte Vermerke (WEISS-N01)                                     */
/* ------------------------------------------------------------------ */

interface BlockEntry {
  reason: InvoicePaymentResyncBlockReason;
  /** ISO-Zeitpunkt der Abweisung. */
  at: string;
}

const BLOCK_REASONS: ReadonlySet<string> = FINAL_OUTCOMES as ReadonlySet<string>;

/** Je Betrieb: Der Schlüssel folgt dem aktiven Speicherbereich wie der übrige Gerätezustand. */
function blockStorageKey(): string {
  return `${getActiveStorageKey()}:invoice-payment-resync-blocks`;
}

function readBlocks(): Record<string, BlockEntry> {
  try {
    const raw = localStorage.getItem(blockStorageKey());
    const value = raw ? (JSON.parse(raw) as unknown) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, BlockEntry> = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      const candidate = entry as Partial<BlockEntry> | null;
      if (candidate && typeof candidate.reason === 'string' && BLOCK_REASONS.has(candidate.reason)) {
        result[id] = { reason: candidate.reason as InvoicePaymentResyncBlockReason, at: String(candidate.at ?? '') };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/*
 * Wer die Vermerke anzeigt, erfährt von jeder Änderung: Der Hintergrundlauf vermerkt
 * eine Abweisung oft, während die Rechnung schon offen ist — ohne Nachricht zeigte die
 * Seite bis zum nächsten Neuzeichnen noch „noch nicht gesichert" statt des Grundes.
 */
const blockListeners = new Set<() => void>();

export function subscribeInvoicePaymentResyncBlocks(listener: () => void): () => void {
  blockListeners.add(listener);
  return () => {
    blockListeners.delete(listener);
  };
}

function writeBlocks(blocks: Record<string, BlockEntry>): void {
  try {
    if (Object.keys(blocks).length === 0) localStorage.removeItem(blockStorageKey());
    else localStorage.setItem(blockStorageKey(), JSON.stringify(blocks));
  } catch {
    /* Ohne Speicher bleibt der Vermerk in dieser Sitzung über `deniedThisSession` wirksam. */
  }
  for (const listener of [...blockListeners]) {
    try {
      listener();
    } catch {
      /* Eine Anzeige darf den Lauf nie stören. */
    }
  }
}

/**
 * Eine endgültige Abweisung vermerken — auch aus der Oberfläche (Knopf „Sichern",
 * Erfassungsformular), damit der Dienst dieselbe Zahlung später nicht still erneut sendet.
 */
export function recordInvoicePaymentResyncBlock(
  invoiceId: string,
  paymentId: string,
  reason: InvoicePaymentResyncBlockReason,
  at: Date = new Date(),
): void {
  const blocks = readBlocks();
  blocks[key(invoiceId, paymentId)] = { reason, at: at.toISOString() };
  writeBlocks(blocks);
  failedAt.delete(key(invoiceId, paymentId));
}

/** Die vermerkten Gründe je Zahlung einer Rechnung — für den Hinweis an der Zahlung. */
export function getInvoicePaymentResyncBlocks(invoiceId: string): Record<string, InvoicePaymentResyncBlockReason> {
  const prefix = `${invoiceId}#`;
  const result: Record<string, InvoicePaymentResyncBlockReason> = {};
  for (const [id, entry] of Object.entries(readBlocks())) {
    if (id.startsWith(prefix)) result[id.slice(prefix.length)] = entry.reason;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Der Lauf                                                            */
/* ------------------------------------------------------------------ */

async function run(deps: InvoicePaymentResyncDeps, now: number): Promise<InvoicePaymentResyncReport> {
  const report: InvoicePaymentResyncReport = { candidates: 0, synced: 0, failed: 0, denied: false };
  const pulled = await (deps.pull ?? (() => pullInvoicePaymentsFromCloud()))();
  if (pulled.outcome !== 'synced') return { ...report, skipped: 'pull_failed' };
  lastRunAt = now;

  // Bewusst alle Kennungen, auch reversierte: Ein Grabstein beweist, dass die Cloud sie kennt.
  const known = new Set(pulled.rows.map((row) => key(row.clientInvoiceId, row.clientPaymentId)));
  const push = deps.push ?? syncInvoicePaymentToCloud;
  const blocks = readBlocks();
  let blocksChanged = false;

  /*
   * Erst alle Kandidaten bestimmen, dann senden: Eine Rollenabweisung gilt für jede
   * Zahlung, die in diesem Moment ungesichert ist — auch für die, die dieser Lauf
   * nicht mehr erreicht.
   */
  const pending: Array<{ invoiceId: string; payment: InvoicePayment; id: string }> = [];
  for (const invoice of (deps.listInvoices ?? listInvoices)()) {
    if (!isFinalizedInvoice(invoice) || isInvoiceCancelled(invoice)) continue;
    for (const payment of getInvoicePayments(invoice)) {
      const id = key(invoice.id, payment.id);
      if (known.has(id)) {
        // Die Cloud kennt sie (anderes Gerät, Knopf): ein alter Vermerk ist erledigt.
        if (blocks[id]) {
          delete blocks[id];
          blocksChanged = true;
        }
        continue;
      }
      if (blocks[id]) {
        report.blocked = (report.blocked ?? 0) + 1;
        continue;
      }
      const lastFailure = failedAt.get(id);
      if (lastFailure !== undefined && now - lastFailure < MIN_INTERVAL_MS) continue;
      pending.push({ invoiceId: invoice.id, payment, id });
    }
  }

  const at = new Date(now).toISOString();
  for (let index = 0; index < pending.length; index += 1) {
    const { invoiceId, payment, id } = pending[index]!;
    report.candidates += 1;
    const outcome = await push(invoiceId, payment);
    if (outcome === 'synced') {
      failedAt.delete(id);
      report.synced += 1;
    } else if (outcome === 'denied') {
      report.denied = true;
      deniedThisSession = true;
      for (const rest of pending.slice(index)) blocks[rest.id] = { reason: 'denied', at };
      writeBlocks(blocks);
      return report;
    } else if (isFinalInvoicePaymentResyncOutcome(outcome)) {
      // Konflikt, unbestätigte Überzahlung, stornierte Rechnung: wartet auf den Nutzer, nicht auf das Netz.
      blocks[id] = { reason: outcome, at };
      blocksChanged = true;
      failedAt.delete(id);
      report.failed += 1;
    } else {
      failedAt.set(id, now);
      report.failed += 1;
    }
  }
  if (blocksChanged) writeBlocks(blocks);
  return report;
}

/**
 * Ein Nachsicherungslauf. Gleichzeitige Aufrufe teilen sich denselben Lauf;
 * `force` umgeht nur den Zehn-Minuten-Abstand des Laufs, nie die Sperren.
 */
export function resyncLocalOnlyInvoicePayments(
  deps: InvoicePaymentResyncDeps = {},
  options: { force?: boolean } = {},
): Promise<InvoicePaymentResyncReport> {
  if (inFlight) return inFlight;
  const empty: InvoicePaymentResyncReport = { candidates: 0, synced: 0, failed: 0, denied: false };
  if (deniedThisSession) return Promise.resolve({ ...empty, skipped: 'denied_earlier' });
  const now = (deps.now ?? Date.now)();
  if (!options.force && lastRunAt !== null && now - lastRunAt < MIN_INTERVAL_MS) {
    return Promise.resolve({ ...empty, skipped: 'throttled' });
  }
  inFlight = run(deps, now)
    .catch(() => ({ ...empty, skipped: 'pull_failed' as const }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Wann ein Planerstatus einen Nachsicherungslauf auslöst: nach einem
 * erfolgreichen automatischen Lauf — und gleich nach dem Start des Planers.
 * Er beginnt erst, nachdem der Bootstrap vollständig abgeglichen hat, und
 * meldet dann `lastOutcome: null`; ohne diesen Fall blieb eine Zahlung nach
 * einem Neustart bis zum nächsten Planerlauf liegen. Nie während eines Laufs
 * und nie nach einem gescheiterten — der Dienst selbst wahrt Abstand und
 * erkennt einen fehlgeschlagenen Abzug.
 */
export function shouldResyncAfterSyncStatus(
  status: Pick<SyncSchedulerStatus, 'running' | 'lastOutcome'> | null,
): boolean {
  if (!status || status.running) return false;
  return status.lastOutcome === 'ok' || status.lastOutcome === null;
}

/**
 * Ein Zahlungsversand ist gerade gescheitert (offline, Netz): Der nächste
 * erfolgreiche Abgleich soll nicht auf den Zehn-Minuten-Abstand warten und
 * frühere Fehlschläge gleich mit wiederholen. Eine Rollenablehnung und ein
 * Datenkonflikt zählen nicht — an ihnen ändert ein neuer Versuch nichts; ihre
 * Vermerke bleiben bestehen.
 */
export function markInvoicePaymentResyncNeeded(): void {
  lastRunAt = null;
  failedAt.clear();
}

/**
 * FINANZ-CORE-01A (SQL-05; WEISS-N01) — der Nutzer hat bewusst neu entschieden
 * (die Überzahlung bestätigt, „Sichern" gedrückt): Diese eine Zahlung darf wieder
 * gesendet werden. Der dauerhafte Vermerk fällt; eine Rollenabweisung hebt das für
 * die übrigen Zahlungen nicht auf.
 */
export function releaseInvoicePaymentResyncConflict(invoiceId: string, paymentId: string): void {
  const blocks = readBlocks();
  if (blocks[key(invoiceId, paymentId)]) {
    delete blocks[key(invoiceId, paymentId)];
    writeBlocks(blocks);
  }
  failedAt.delete(key(invoiceId, paymentId));
  lastRunAt = null;
}

/**
 * Nur für Tests: alles zurück, auch die dauerhaften Vermerke des aktiven Betriebs.
 * Einen Neustart bilden Tests mit einem frisch geladenen Modul nach (`vi.resetModules`) —
 * dabei bleiben die Vermerke im Gerätespeicher, wie im Betrieb.
 */
export function resetInvoicePaymentResyncForTests(): void {
  lastRunAt = null;
  deniedThisSession = false;
  inFlight = null;
  failedAt.clear();
  writeBlocks({});
}
