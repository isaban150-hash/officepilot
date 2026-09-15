/**
 * UIUX-FOUNDATION-01B — kanonisches UI-Statussystem.
 *
 * Fachstatus → semantischer Ton. Seiten und Komponenten definieren keine
 * eigenen Statusfarben mehr, sondern fragen hier nach dem Ton und geben ihn
 * an `Badge`/`StatusBadge` weiter. Die Töne sind bewusst wenige; ein neuer
 * Fachstatus bekommt keinen neuen Ton, sondern wird einem bestehenden
 * zugeordnet.
 *
 * Nur sichere Zuordnungen: Die Semantik der Fachstatus wird hier nicht
 * verändert, lediglich gelesen. Unbekannte Werte fallen auf `neutral`.
 */
import type { ExpensePaymentStatus } from '../../types/expense';
import type { InboxStatus, InvoicePaymentStatus, TaskStatus, VorgangStatus } from '../../types/models';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'critical';

export const STATUS_TONES: readonly StatusTone[] = ['neutral', 'info', 'success', 'warning', 'critical'];

/** Offen ist der Normalzustand, Storniert ist historisch — beide ruhig, nicht alarmierend. */
const PAYMENT_TONE: Record<InvoicePaymentStatus, StatusTone> = {
  offen: 'neutral',
  teilbezahlt: 'warning',
  bezahlt: 'success',
  ueberfaellig: 'critical',
  storniert: 'neutral',
};

/** Rechnungen und Ausgaben teilen dieselben Zahlungsstatus-Werte. */
export function paymentStatusTone(status: InvoicePaymentStatus | ExpensePaymentStatus): StatusTone {
  return PAYMENT_TONE[status] ?? 'neutral';
}

const TASK_TONE: Record<TaskStatus, StatusTone> = {
  open: 'neutral',
  in_progress: 'info',
  done: 'success',
  archived: 'neutral',
};

export function taskStatusTone(status: TaskStatus): StatusTone {
  return TASK_TONE[status] ?? 'neutral';
}

/** `spaeter_klaeren` ist eine bewusste Rückstellung durch den Nutzer — Hinweis, kein Alarm. */
const INBOX_TONE: Record<InboxStatus, StatusTone> = {
  neu: 'info',
  geprueft: 'success',
  abgelegt: 'neutral',
  spaeter_klaeren: 'warning',
};

export function inboxStatusTone(status: InboxStatus): StatusTone {
  return INBOX_TONE[status] ?? 'neutral';
}

/**
 * Vorgangsstatus: laufende Zustände sind `info`, „wartet“ ist der einzige
 * Zustand, der Aufmerksamkeit verlangt, „abgeschlossen“ ist erledigt.
 */
const VORGANG_TONE: Record<VorgangStatus, StatusTone> = {
  neu: 'neutral',
  eingegangen: 'neutral',
  in_pruefung: 'info',
  in_verhandlung: 'info',
  beauftragt: 'info',
  in_bearbeitung: 'info',
  wartet: 'warning',
  abgeschlossen: 'success',
};

export function vorgangStatusTone(status: VorgangStatus): StatusTone {
  return VORGANG_TONE[status] ?? 'neutral';
}

/** Prüf-/Freigabezustände, die mehrere Bereiche teilen (Dokumente, Positionen, Rechnungen). */
export type ReviewLikeState = 'draft' | 'needs_review' | 'in_review' | 'confirmed' | 'finalized' | 'sent' | 'error' | 'conflict';

const REVIEW_TONE: Record<ReviewLikeState, StatusTone> = {
  draft: 'neutral',
  needs_review: 'warning',
  in_review: 'info',
  confirmed: 'success',
  finalized: 'success',
  sent: 'info',
  error: 'critical',
  conflict: 'critical',
};

export function reviewStateTone(state: ReviewLikeState): StatusTone {
  return REVIEW_TONE[state] ?? 'neutral';
}

export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === 'string' && (STATUS_TONES as readonly string[]).includes(value);
}
