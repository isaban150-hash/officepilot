/**
 * BROWSER-ACCEPTANCE-FIX 01 / B1 — „Was soll ich heute erledigen?"
 *
 * Allgemeine Prioritätsfragen landeten im Workflow-Resolver (`/was soll/`).
 * Der kennt nur den zuletzt geöffneten Auftrag aus der Sitzung; überfällige
 * Rechnungen und Aufgaben des Betriebs sah er nie. Die Antwort drehte sich
 * deshalb um einen einzelnen Testauftrag, während „Jetzt wichtig" drei
 * überfällige Rechnungen und vier überfällige Aufgaben zeigte.
 *
 * Diese Frage beantwortet jetzt dieselbe fachliche Quelle wie „Jetzt wichtig"
 * (`scanPendingItems` / `buildPendingSummary` / `listDueTasks`) — nur lesend:
 * Die Heute-Seite legt beim Scannen Aufgaben für überfällige Rechnungen an,
 * eine Frage an den Assistenten nicht. Keine zweite Heute-Logik, keine
 * erfundenen Fristen oder Beträge: Jede Zeile stammt aus einem vorhandenen
 * Datensatz. Aktionen sind reine Navigation; nichts wird erledigt, geändert
 * oder versendet.
 *
 * Reihenfolge, nachvollziehbar:
 *   1. überfällig / Frist überschritten
 *   2. heute fällig
 *   3. bald fällig
 *   4. sonstige offene Arbeit (Eingang, fehlende Nachweise, Teilzahlungen)
 */
import type { AssistantAction, AssistantAnswer, PendingItem, Task } from '../../types/models';
import { buildPendingSummary, listDueTasks, scanPendingItems } from '../pendingEngineService';
import { formatDisplayDatePadded } from '../../utils/displayFormat';
import { countLabel } from '../../utils/germanCount';

const OVERDUE_KINDS = new Set<PendingItem['kind']>(['invoice_overdue', 'expense_overdue', 'document_expired']);
const TODAY_KINDS = new Set<PendingItem['kind']>(['invoice_due_today', 'expense_due_today']);
const SOON_KINDS = new Set<PendingItem['kind']>(['invoice_due_soon', 'document_expiring']);

const MAX_OVERDUE_LINES = 5;
const MAX_TODAY_LINES = 3;
const MAX_SOON_LINES = 3;


function normalize(question: string): string {
  return question
    .toLowerCase()
    .replace(/[?!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Allgemeine Fragen nach dem, was jetzt ansteht. Bewusst eng: Fragen zu einem
 * bestimmten Auftrag („Was fehlt im Auftrag?", „nächster Schritt") bleiben
 * beim Workflow-Resolver.
 */
export function isDailyPriorityQuestion(question: string): boolean {
  const q = normalize(question);
  if (!q) return false;
  if (/\b(auftrag|vorgang|dokument|rechnung \S*\d)/.test(q) && !/\bheute\b/.test(q)) return false;
  return (
    /\bwas (soll|muss|sollte) ich (heute|jetzt|als erstes|zuerst|noch)\b.*\b(erledigen|machen|tun|anfangen|angehen)\b/.test(q) ||
    /\bwas (ist|steht) (heute|jetzt|gerade) (wichtig|dringend|an)\b/.test(q) ||
    /\bwas ist (heute |jetzt |gerade )?(besonders )?dringend\b/.test(q) ||
    /\bwas (muss|soll) ich noch (machen|erledigen|tun)\b/.test(q) ||
    /\bwas steht heute an\b/.test(q) ||
    /\bwas (ist|gibt es) heute zu tun\b/.test(q)
  );
}

function dueSuffix(dueDate: string | undefined, prefix: string): string {
  return dueDate ? ` (${prefix} ${formatDisplayDatePadded(dueDate.slice(0, 10))})` : '';
}

/** Die Gruppe („Überfällig:", „Heute:") sagt es schon — der Titel wiederholt es nicht. */
function withoutStatusSuffix(title: string): string {
  return title.replace(/\s+(überfällig|heute fällig)$/u, '');
}

function itemLine(item: PendingItem, prefix: string): string {
  const description = item.description?.trim() ? ` – ${item.description.trim()}` : '';
  if (item.kind === 'invoice_overdue' || item.kind === 'expense_overdue') {
    return `${withoutStatusSuffix(item.title)}${dueSuffix(item.dueDate, 'fällig seit')}${description}`;
  }
  if (item.kind === 'invoice_due_today' || item.kind === 'expense_due_today') {
    return `${withoutStatusSuffix(item.title)}${description}`;
  }
  if (item.kind === 'document_expiring') return expiringLine(item);
  if (item.kind === 'document_expired') {
    const label = String(item.metadata?.proofLabel ?? '').trim() || item.title;
    return `${label} ist abgelaufen${dueSuffix(item.dueDate, 'seit')}`;
  }
  if (item.kind === 'authority_deadline') {
    return `Frist: ${item.title}${dueSuffix(item.dueDate, prefix)}`;
  }
  return `${item.title}${description}`;
}

/**
 * B1-Nacharbeit — welches Datum trägt eine Aufgabe?
 *
 * `Task` hat nur `dueDate`. Was es bedeutet, entscheidet die Aufgabenart:
 *
 *   * Wiedervorlage (`taskKind: 'document_reminder'`, angelegt über
 *     `documentReminderProposalService`): `dueDate` ist der **Erinnerungstag**
 *     (`remindOn`). Die Frist aus dem Schreiben steht strukturiert im
 *     `dedupeKey` (`reminder:<eingang>:<art>:<frist>:<erinnerung>`).
 *   * jede andere Aufgabe: `dueDate` ist ihre **Fälligkeit**.
 *
 * Echte Fristen (Behörden) kommen nicht von hier, sondern als
 * `authority_deadline` aus `scanAuthorityDeadlines` und heissen dort „Frist".
 * Gezählt wird weiter nach `dueDate` — wie auf „Jetzt wichtig".
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function reminderDeadlineOf(task: Pick<Task, 'taskKind' | 'dedupeKey' | 'dueDate'>): string | null {
  if (task.taskKind !== 'document_reminder') return null;
  const parts = (task.dedupeKey ?? '').split(':');
  if (parts[0] !== 'reminder' || parts.length < 5) return null;
  const deadline = parts[parts.length - 2]!;
  const remindOn = parts[parts.length - 1]!;
  if (!ISO_DAY.test(deadline) || !ISO_DAY.test(remindOn)) return null;
  // Nur wenn der Schlüssel zu genau dieser Erinnerung gehört.
  if (task.dueDate && task.dueDate.slice(0, 10) !== remindOn) return null;
  return deadline;
}

/** Der Titel einer Wiedervorlage nennt die Frist schon („… – Frist 22.09.2026"). */
function withoutDeadlineSuffix(title: string): string {
  return title.replace(/\s+–\s+Frist\s+\d{2}\.\d{2}\.\d{4}$/u, '');
}

function taskLine(task: Task, overdue: boolean, todayIso: string): string {
  const day = task.dueDate ? task.dueDate.slice(0, 10) : '';
  const shown = day ? formatDisplayDatePadded(day) : '';
  const isReminder = task.taskKind === 'document_reminder';
  if (!isReminder) {
    return overdue
      ? `Aufgabe „${task.title}“${shown ? ` (fällig seit ${shown})` : ''}`
      : `Aufgabe „${task.title}“ (heute fällig)`;
  }

  const deadline = reminderDeadlineOf(task);
  const title = deadline ? withoutDeadlineSuffix(task.title) : task.title;
  const reminder = overdue ? `Erinnerung vom ${shown} ist offen` : 'Erinnerung für heute';
  if (!deadline) return `Wiedervorlage „${title}“ (${reminder})`;
  const deadlineShown = formatDisplayDatePadded(deadline);
  const deadlineState =
    deadline < todayIso
      ? `Frist im Schreiben ${deadlineShown} überschritten`
      : deadline === todayIso
        ? `Frist im Schreiben heute (${deadlineShown})`
        : `Frist im Schreiben am ${deadlineShown}`;
  return `Wiedervorlage „${title}“ (${reminder}; ${deadlineState})`;
}

/**
 * B1-Nacharbeit — ablaufendes Dokument mit derselben Bezeichnung wie auf
 * „Jetzt wichtig" (`metadata.proofLabel`: Nachweisart oder Dokumenttitel samt
 * Nummer, etwa „AN-2026-0001 – Angebot"). Keine Nummer wird erfunden.
 */
function expiringLine(item: PendingItem): string {
  const label = String(item.metadata?.proofLabel ?? '').trim() || item.title;
  const days = item.daysUntilDue;
  if (days === undefined) return `${label} läuft bald ab`;
  if (days <= 0) return `${label} läuft heute ab`;
  return `${label} läuft in ${days === 1 ? '1 Tag' : `${days} Tagen`} ab`;
}

function byDueDate<T extends { dueDate?: string }>(a: T, b: T): number {
  return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
}

export interface DailyPriorityResolution {
  answer: AssistantAnswer;
  /** Die Zählung, auf der die Antwort beruht — dieselbe wie auf „Heute". */
  counts: {
    overdueInvoices: number;
    overdueTasks: number;
    dueTodayInvoices: number;
    dueTasksToday: number;
    overdueExpenses: number;
    dueTodayExpenses: number;
    authorityDeadlines: number;
  };
}

export function buildDailyPriorityAnswer(todayIso: string): DailyPriorityResolution {
  const { items } = scanPendingItems(todayIso, { readOnly: true });
  const summary = buildPendingSummary(items, todayIso);
  const tasks = listDueTasks(todayIso);

  const authority = items.filter((item) => item.kind === 'authority_deadline');
  const authorityOverdue = authority.filter((item) => (item.daysUntilDue ?? 1) < 0);
  const authorityToday = authority.filter((item) => item.daysUntilDue === 0);
  const authoritySoon = authority.filter((item) => (item.daysUntilDue ?? -1) > 0);

  const overdueItems = [...authorityOverdue, ...items.filter((item) => OVERDUE_KINDS.has(item.kind))].sort(byDueDate);
  const todayItems = [...authorityToday, ...items.filter((item) => TODAY_KINDS.has(item.kind))];
  const soonItems = [...authoritySoon, ...items.filter((item) => SOON_KINDS.has(item.kind))].sort(byDueDate);

  /*
   * Aufgaben „Zahlung prüfen" gehören zu einer überfälligen Rechnung, die schon
   * darüber steht. Sie zählen weiter mit (wie auf „Heute"), werden aber nicht
   * ein zweites Mal als eigene Zeile aufgeführt.
   */
  const listedInvoiceIds = new Set(
    items.filter((item) => item.sourceType === 'invoice').map((item) => item.sourceId),
  );
  const overdueTaskLines = [...tasks.overdue]
    .sort(byDueDate)
    .filter((task) => !(task.linkedInvoiceId && listedInvoiceIds.has(task.linkedInvoiceId)));
  const todayTaskLines = tasks.today.filter(
    (task) => !(task.linkedInvoiceId && listedInvoiceIds.has(task.linkedInvoiceId)),
  );

  const bullets: string[] = [];
  const overdueLines = [
    ...overdueItems.map((item) => itemLine(item, 'Frist')),
    ...overdueTaskLines.map((task) => taskLine(task, true, todayIso)),
  ];
  overdueLines.slice(0, MAX_OVERDUE_LINES).forEach((line) => bullets.push(`Überfällig: ${line}`));
  if (overdueLines.length > MAX_OVERDUE_LINES) {
    bullets.push(`Überfällig: ${countLabel(overdueLines.length - MAX_OVERDUE_LINES, 'weiterer Punkt', 'weitere Punkte')}`);
  }
  // Die mitgezählten, aber nicht einzeln aufgeführten Aufgaben — damit die Zahl oben nachvollziehbar bleibt.
  const foldedOverdueTasks = tasks.overdue.length - overdueTaskLines.length;
  if (foldedOverdueTasks > 0) {
    bullets.push(
      `Überfällig: ${foldedOverdueTasks === 1 ? '1 Aufgabe betrifft' : `${foldedOverdueTasks} Aufgaben betreffen`} die Zahlung der Rechnungen oben.`,
    );
  }

  const todayLines = [
    ...todayItems.map((item) => itemLine(item, 'Frist heute')),
    ...todayTaskLines.map((task) => taskLine(task, false, todayIso)),
  ];
  todayLines.slice(0, MAX_TODAY_LINES).forEach((line) => bullets.push(`Heute: ${line}`));
  if (todayLines.length > MAX_TODAY_LINES) {
    bullets.push(`Heute: ${countLabel(todayLines.length - MAX_TODAY_LINES, 'weiterer Punkt', 'weitere Punkte')}`);
  }

  soonItems
    .slice(0, MAX_SOON_LINES)
    .forEach((item) => bullets.push(`Bald: ${itemLine(item, 'Frist')}`));

  const otherLines: string[] = [];
  if (summary.newInboxItems > 0) {
    otherLines.push(`Im Eingang ${summary.newInboxItems === 1 ? 'wartet 1 neues Dokument' : `warten ${summary.newInboxItems} neue Dokumente`} auf Ihre Prüfung.`);
  }
  if (summary.deferredInboxItems > 0) {
    otherLines.push(`${countLabel(summary.deferredInboxItems, 'Dokument ist', 'Dokumente sind')} zum späteren Klären zurückgestellt.`);
  }
  if (summary.missingContractDocuments > 0) {
    otherLines.push(`${countLabel(summary.missingContractDocuments, 'Nachweis fehlt', 'Nachweise fehlen')} zu einem Vertrag.`);
  }
  if (summary.partialInvoices > 0) {
    otherLines.push(`${countLabel(summary.partialInvoices, 'Rechnung ist', 'Rechnungen sind')} erst teilweise bezahlt.`);
  }
  otherLines.forEach((line) => bullets.push(`Außerdem: ${line}`));

  const counts = {
    overdueInvoices: summary.overdueInvoices,
    overdueTasks: summary.overdueTasks,
    dueTodayInvoices: summary.dueTodayInvoices,
    dueTasksToday: summary.dueTasksToday,
    overdueExpenses: summary.overdueExpenses,
    dueTodayExpenses: summary.dueTodayExpenses,
    authorityDeadlines: summary.authorityDeadlines,
  };

  const overdueParts = [
    summary.overdueInvoices > 0 ? countLabel(summary.overdueInvoices, 'überfällige Rechnung', 'überfällige Rechnungen') : '',
    summary.overdueExpenses > 0 ? countLabel(summary.overdueExpenses, 'überfällige Ausgabe', 'überfällige Ausgaben') : '',
    summary.overdueTasks > 0 ? countLabel(summary.overdueTasks, 'überfällige Aufgabe', 'überfällige Aufgaben') : '',
    authorityOverdue.length > 0 ? countLabel(authorityOverdue.length, 'überschrittene Frist', 'überschrittene Fristen') : '',
  ].filter(Boolean);
  const todayCount = todayItems.length + tasks.today.length;

  let summaryText: string;
  if (overdueParts.length > 0) {
    summaryText = `Zuerst das Überfällige: ${joinGerman(overdueParts)}.`;
    if (todayCount > 0) summaryText += ` Danach, was heute fällig ist (${todayCount}).`;
  } else if (todayCount > 0) {
    summaryText = `Nichts ist überfällig. Heute fällig: ${countLabel(todayCount, 'Punkt', 'Punkte')}.`;
  } else if (bullets.length > 0) {
    summaryText = 'Nichts ist überfällig und heute ist nichts fällig. Diese offenen Punkte stehen als Nächstes an.';
  } else {
    summaryText =
      'Aktuell liegt nichts Dringendes vor: keine überfälligen Rechnungen oder Aufgaben und nichts, was heute fällig ist.';
  }

  const actions: AssistantAction[] = [];
  if (summary.overdueInvoices + summary.dueTodayInvoices + summary.dueSoonInvoices + summary.partialInvoices > 0) {
    actions.push({ id: 'daily-invoices', label: 'Offene Rechnungen ansehen', route: '/rechnungen/offen' });
  }
  if (summary.overdueTasks + summary.dueTasksToday + authority.length > 0) {
    actions.push({ id: 'daily-tasks', label: 'Aufgaben ansehen', route: '/aufgaben' });
  }
  if (summary.overdueExpenses + summary.dueTodayExpenses > 0) {
    actions.push({ id: 'daily-expenses', label: 'Offene Ausgaben ansehen', route: '/ausgaben/offen' });
  }
  if (summary.newInboxItems + summary.deferredInboxItems > 0) {
    actions.push({ id: 'daily-inbox', label: 'Eingang öffnen', route: '/ablage' });
  }

  return {
    answer: { title: 'Heute wichtig', summary: summaryText, bullets, actions },
    counts,
  };
}

function joinGerman(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}

export function tryResolveDailyPriorityQuestion(
  question: string,
  todayIso: string,
): DailyPriorityResolution | null {
  if (!isDailyPriorityQuestion(question)) return null;
  return buildDailyPriorityAnswer(todayIso);
}
