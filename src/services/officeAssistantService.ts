import { analyzeContractFromInbox } from './contractAnalysisService';
import { getAllDocuments } from './documentService';
import {
  getAllInvoiceOverview,
  getOpenInvoices,
  getOverdueInvoices,
  getPaidInvoices,
  getPartialInvoices,
  summarizeInvoiceOverview,
  type InvoiceOverviewItem,
} from './invoiceOverviewService';
import { filterActiveItems, getInboxItems } from './inboxService';
import {
  scanExpiringDocuments,
  scanPendingItems,
  scanRequiredContractDocuments,
} from './pendingEngineService';
import { getTasksFiltered } from './taskEngineService';
import { getAllTasksFromStore } from './taskStore';
import { isTaskOpen } from './taskNormalize';
import { getTodayIso } from './taskNormalize';
import {
  memoryQueryAnswerToAssistantAnswer,
  tryMemoryQueryAnswer,
} from './memory/memoryQueryService';
import {
  EXPLANATION_NO_DATA_MESSAGE,
  findDocumentForExplanationQuestion,
} from './memory/documentExplanationService';
import { getAllVorgaenge } from './vorgangService';
import type { AssistantAction, AssistantAnswer, CompanyDocument, Task, Vorgang } from '../types/models';

function getOpenTasks(): Task[] {
  return getAllTasksFromStore().filter(isTaskOpen);
}

function getTodayTasks(referenceDate?: Date | string): Task[] {
  return getTasksFiltered('heute', referenceDate ?? new Date());
}

export const NO_DATA_MESSAGE = 'Ich habe dazu aktuell keine Informationen.';

export const ASSISTANT_EXAMPLE_QUESTION_KEYS = [
  'assistant.q1',
  'assistant.q2',
  'assistant.q3',
  'assistant.q4',
  'assistant.q5',
] as const;

export type AssistantExampleQuestionKey = (typeof ASSISTANT_EXAMPLE_QUESTION_KEYS)[number];

export type AssistantIntent =
  | 'tasks_today'
  | 'tasks_open'
  | 'invoices_open'
  | 'invoices_paid'
  | 'invoices_overdue'
  | 'invoices_abschlag'
  | 'documents_missing'
  | 'documents_expiring'
  | 'documents_freistellung_list'
  | 'documents_freistellung_location'
  | 'contracts_missing_proofs'
  | 'contracts_werkvertrag'
  | 'vorgaenge_open'
  | 'vorgaenge_active_sites'
  | 'payments_unpaid_customers'
  | 'payments_open_amount'
  | 'payments_partial'
  | 'dashboard_important'
  | 'dashboard_attention'
  | 'unknown';

const FREISTELLUNG_PATTERN = /freistellungsbescheinigung/i;
const MAX_BULLETS = 8;

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .trim()
    .replace(/[^\wäöüß0-9\s?]/gi, ' ')
    .replace(/\s+/g, ' ');
}

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function noDataAnswer(title = 'Keine Informationen'): AssistantAnswer {
  return {
    title,
    summary: NO_DATA_MESSAGE,
    bullets: [],
    actions: [],
  };
}

function withBullets(
  title: string,
  summary: string,
  bullets: string[],
  actions: AssistantAction[] = [],
  linkedRoute?: string,
): AssistantAnswer {
  const limited = limitBullets(bullets);
  const finalBullets = [...limited.bullets];
  if (limited.remaining > 0) {
    finalBullets.push(`… und ${limited.remaining} weitere`);
  }
  return {
    title,
    summary,
    bullets: finalBullets,
    actions: dedupeActions(actions),
    linkedRoute,
  };
}

function limitBullets(items: string[]): { bullets: string[]; remaining: number } {
  if (items.length <= MAX_BULLETS) {
    return { bullets: items, remaining: 0 };
  }
  return { bullets: items.slice(0, MAX_BULLETS), remaining: items.length - MAX_BULLETS };
}

function dedupeActions(actions: AssistantAction[]): AssistantAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.route)) return false;
    seen.add(action.route);
    return true;
  });
}

function invoiceRoute(entry: InvoiceOverviewItem): string {
  return `/vorgaenge/${entry.vorgangId}/rechnungen/${entry.invoice.id}`;
}

function invoiceAction(entry: InvoiceOverviewItem): AssistantAction {
  return {
    id: `invoice-${entry.invoice.id}`,
    label: `Rechnung ${entry.invoice.number} öffnen`,
    route: invoiceRoute(entry),
  };
}

function taskRoute(task: Task): string {
  if (task.linkedVorgangId && task.linkedInvoiceId) {
    return `/vorgaenge/${task.linkedVorgangId}/rechnungen/${task.linkedInvoiceId}`;
  }
  if (task.linkedDocumentId) return `/dokumente/${task.linkedDocumentId}`;
  if (task.linkedInboxId) return `/eingang/${task.linkedInboxId}`;
  if (task.linkedVorgangId) return `/vorgaenge/${task.linkedVorgangId}`;
  return '/aufgaben';
}

function taskAction(task: Task): AssistantAction {
  return {
    id: `task-${task.id}`,
    label: task.title,
    route: taskRoute(task),
  };
}

function documentMatchesFreistellung(doc: CompanyDocument): boolean {
  return (
    FREISTELLUNG_PATTERN.test(doc.title) ||
    FREISTELLUNG_PATTERN.test(doc.recognizedText) ||
    doc.tags.some((tag) => FREISTELLUNG_PATTERN.test(tag))
  );
}

function isOpenVorgang(vorgang: Vorgang): boolean {
  return vorgang.status !== 'abgeschlossen';
}

export function detectIntent(question: string): AssistantIntent {
  const q = normalizeQuestion(question);
  if (!q) return 'unknown';

  if (
    /was (ist|muss).*(heute ).*(wichtig|beachten)/.test(q) ||
    /heute (wichtig|beachten)/.test(q) ||
    /was muss ich beachten/.test(q)
  ) {
    return /beachten/.test(q) ? 'dashboard_attention' : 'dashboard_important';
  }

  if (
    /was muss ich heute/.test(q) ||
    (/heute/.test(q) && /(machen|erledigen|tun|aufgaben)/.test(q))
  ) {
    return 'tasks_today';
  }

  if (/was ist offen/.test(q)) {
    if (/rechnung/.test(q)) return 'invoices_open';
    if (/vorgang/.test(q)) return 'vorgaenge_open';
    return 'tasks_open';
  }

  if (/(offene|welche) aufgaben|aufgaben habe ich|aufgaben sind offen/.test(q)) {
    return 'tasks_open';
  }

  if (/überfällig/.test(q) && /rechnung/.test(q)) return 'invoices_overdue';
  if (/rechnung/.test(q) && /bezahlt/.test(q)) return 'invoices_paid';
  if (/teilbezahlt/.test(q) || (/rechnung/.test(q) && /teil/.test(q))) {
    return 'payments_partial';
  }
  if (/rechnung/.test(q) && /offen/.test(q)) return 'invoices_open';
  if (/abschlag/.test(q)) return 'invoices_abschlag';

  if (/wie viel geld|offener betrag|noch offen|offene forderungen/.test(q)) {
    return 'payments_open_amount';
  }
  if (/kunden.*(nicht|noch nicht).*bezahlt|welche kunden.*bezahlt/.test(q)) {
    return 'payments_unpaid_customers';
  }

  if (/nachweise fehlen|fehlende nachweise/.test(q)) return 'contracts_missing_proofs';
  if (/dokumente fehlen|welche dokumente fehlen/.test(q)) return 'documents_missing';

  if (/laufen ab|ablauf|ablaufende/.test(q) && /dokument|nachweis|freistellung/.test(q)) {
    return 'documents_expiring';
  }

  if (/wo liegt.*freistellung|freistellung.*(liegt|ablage|speicher)/.test(q)) {
    return 'documents_freistellung_location';
  }
  if (/freistellung/.test(q)) return 'documents_freistellung_list';

  if (/werkvertrag/.test(q)) return 'contracts_werkvertrag';

  if (/offene vorgänge|offene vorgaenge|zeige.*vorgänge/.test(q)) return 'vorgaenge_open';
  if (/baustelle/.test(q) && /(aktiv|laufen|offen)/.test(q)) return 'vorgaenge_active_sites';

  return 'unknown';
}

export function answerQuestion(question: string, today?: Date | string): AssistantAnswer {
  const todayIso = getTodayIso(today);
  const memoryAnswer = tryMemoryQueryAnswer(question, todayIso);
  if (memoryAnswer) {
    return memoryQueryAnswerToAssistantAnswer(memoryAnswer);
  }

  if (/was bedeutet|was muss ich tun|was wollte|was ist mit.*freistellung|fehlen nachweise/i.test(question)) {
    const explanation = findDocumentForExplanationQuestion(question);
    if (explanation) {
      return memoryQueryAnswerToAssistantAnswer(
        {
          shortAnswer: explanation.shortAnswer,
          source: `Firmen-Gedächtnis: ${explanation.sourceTitle ?? 'Dokument'}`,
          digitalLocation: explanation.digitalLocation,
          paperLocation: explanation.paperLocation,
          register: explanation.register,
          status: explanation.actionRequired,
          nextStep: explanation.nextSteps[0] ?? explanation.recommendation,
          uncertainty: explanation.uncertaintyNote,
        },
        'Dokument-Erklärung',
      );
    }
    return {
      title: 'Dokument-Erklärung',
      summary: EXPLANATION_NO_DATA_MESSAGE,
      bullets: [],
      actions: [],
    };
  }

  const intent = detectIntent(question);

  switch (intent) {
    case 'tasks_today':
      return answerTasksToday(todayIso);
    case 'tasks_open':
      return answerTasksOpen();
    case 'invoices_open':
      return answerInvoicesOpen(todayIso);
    case 'invoices_paid':
      return answerInvoicesPaid(todayIso);
    case 'invoices_overdue':
      return answerInvoicesOverdue(todayIso);
    case 'invoices_abschlag':
      return answerInvoicesAbschlag(todayIso);
    case 'documents_missing':
      return answerDocumentsMissing();
    case 'documents_expiring':
      return answerDocumentsExpiring(todayIso);
    case 'documents_freistellung_list':
      return answerFreistellungList();
    case 'documents_freistellung_location':
      return answerFreistellungLocation();
    case 'contracts_missing_proofs':
      return answerMissingProofs();
    case 'contracts_werkvertrag':
      return answerWerkvertraege();
    case 'vorgaenge_open':
      return answerOpenVorgaenge();
    case 'vorgaenge_active_sites':
      return answerActiveBaustellen();
    case 'payments_unpaid_customers':
      return answerUnpaidCustomers(todayIso);
    case 'payments_open_amount':
      return answerOpenAmount(todayIso);
    case 'payments_partial':
      return answerPartialInvoices(todayIso);
    case 'dashboard_important':
    case 'dashboard_attention':
      return answerDashboard(todayIso);
    default:
      return noDataAnswer();
  }
}

function answerTasksToday(todayIso: string): AssistantAnswer {
  const tasks = getTodayTasks(todayIso);
  if (tasks.length === 0) return noDataAnswer('Heute erledigen');

  return withBullets(
    'Heute erledigen',
    `${tasks.length} Aufgabe${tasks.length === 1 ? '' : 'n'} mit Frist bis heute oder früher.`,
    tasks.map((task) => formatTaskBullet(task)),
    [
      { id: 'open-tasks', label: 'Aufgaben öffnen', route: '/aufgaben' },
      ...tasks.map(taskAction),
    ],
    '/aufgaben',
  );
}

function answerTasksOpen(): AssistantAnswer {
  const tasks = getOpenTasks();
  if (tasks.length === 0) return noDataAnswer('Offene Aufgaben');

  return withBullets(
    'Offene Aufgaben',
    `${tasks.length} offene Aufgabe${tasks.length === 1 ? '' : 'n'}.`,
    tasks.map((task) => formatTaskBullet(task)),
    [
      { id: 'open-tasks', label: 'Aufgaben öffnen', route: '/aufgaben' },
      ...tasks.map(taskAction),
    ],
    '/aufgaben',
  );
}

function formatTaskBullet(task: Task): string {
  const due = task.dueDate ? ` (Frist: ${task.dueDate})` : '';
  const vorgang = task.linkedVorgangTitle ? ` – ${task.linkedVorgangTitle}` : '';
  return `${task.title}${vorgang}${due}`;
}

function answerInvoicesOpen(todayIso: string): AssistantAnswer {
  const items = getOpenInvoices(todayIso);
  if (items.length === 0) return noDataAnswer('Offene Rechnungen');

  const totalOpen = items.reduce((sum, item) => sum + item.paymentSummary.openAmount, 0);
  return withBullets(
    'Offene Rechnungen',
    `${items.length} offene Rechnung${items.length === 1 ? '' : 'en'} – gesamt ${formatEuro(totalOpen)} offen.`,
    items.map((item) => formatInvoiceBullet(item)),
    [
      { id: 'open-invoices', label: 'Offene Rechnungen anzeigen', route: '/rechnungen/offen' },
      ...items.map(invoiceAction),
    ],
    '/rechnungen/offen',
  );
}

function answerInvoicesPaid(todayIso: string): AssistantAnswer {
  const items = getPaidInvoices(todayIso);
  if (items.length === 0) return noDataAnswer('Bezahlte Rechnungen');

  return withBullets(
    'Bezahlte Rechnungen',
    `${items.length} bezahlte Rechnung${items.length === 1 ? '' : 'en'}.`,
    items.map((item) => `${item.invoice.number} – ${item.customer} (${formatEuro(item.paymentSummary.paidAmount)} bezahlt)`),
    [{ id: 'paid-invoices', label: 'Rechnungsübersicht öffnen', route: '/rechnungen/offen' }],
    '/rechnungen/offen',
  );
}

function answerInvoicesOverdue(todayIso: string): AssistantAnswer {
  const items = getOverdueInvoices(todayIso);
  if (items.length === 0) return noDataAnswer('Überfällige Rechnungen');

  return withBullets(
    'Überfällige Rechnungen',
    `${items.length} überfällige Rechnung${items.length === 1 ? '' : 'en'}.`,
    items.map((item) => formatInvoiceBullet(item, true)),
    [
      { id: 'overdue-invoices', label: 'Offene Rechnungen anzeigen', route: '/rechnungen/offen' },
      ...items.map(invoiceAction),
    ],
    '/rechnungen/offen',
  );
}

function answerInvoicesAbschlag(todayIso: string): AssistantAnswer {
  const items = getAllInvoiceOverview(todayIso).filter((item) => item.invoice.type === 'abschlag');
  if (items.length === 0) return noDataAnswer('Abschlagsrechnungen');

  return withBullets(
    'Abschlagsrechnungen',
    `${items.length} Abschlagsrechnung${items.length === 1 ? '' : 'en'} im System.`,
    items.map((item) => formatInvoiceBullet(item)),
    [{ id: 'abschlag-invoices', label: 'Rechnungsübersicht öffnen', route: '/rechnungen/offen' }],
    '/rechnungen/offen',
  );
}

function formatInvoiceBullet(item: InvoiceOverviewItem, overdue = false): string {
  const due = item.invoice.paymentDueDate ? `, fällig ${item.invoice.paymentDueDate}` : '';
  const suffix = overdue ? ' – überfällig' : '';
  return `${item.invoice.number} – ${item.customer}: ${formatEuro(item.paymentSummary.openAmount)} offen${due}${suffix}`;
}

function answerDocumentsMissing(): AssistantAnswer {
  const missing = scanRequiredContractDocuments();
  if (missing.length === 0) return noDataAnswer('Fehlende Dokumente');

  return withBullets(
    'Fehlende Dokumente',
    `${missing.length} fehlende Vertragsunterlage${missing.length === 1 ? '' : 'n'}.`,
    missing.map((item) => item.title + (item.description ? ` (${item.description})` : '')),
    [
      { id: 'inbox', label: 'Eingang öffnen', route: '/eingang' },
      ...missing.map((item) => ({
        id: item.id,
        label: item.title,
        route: item.route,
      })),
    ],
    '/eingang',
  );
}

function answerDocumentsExpiring(todayIso: string): AssistantAnswer {
  const expiring = scanExpiringDocuments(todayIso).filter(
    (item) => item.kind === 'document_expiring' || item.kind === 'document_expired',
  );
  if (expiring.length === 0) return noDataAnswer('Ablaufende Dokumente');

  return withBullets(
    'Ablaufende Nachweise',
    `${expiring.length} Dokument${expiring.length === 1 ? '' : 'e'} mit ablaufender oder abgelaufener Gültigkeit.`,
    expiring.map((item) => {
      if (item.kind === 'document_expired') {
        return `${item.title} – abgelaufen${item.dueDate ? ` (${item.dueDate})` : ''}`;
      }
      return `${item.title} – läuft in ${item.daysUntilDue ?? '?'} Tagen ab`;
    }),
    [
      { id: 'documents', label: 'Dokumente öffnen', route: '/dokumente' },
      ...expiring.map((item) => ({
        id: item.id,
        label: item.title,
        route: item.route,
      })),
    ],
    '/dokumente',
  );
}

function answerFreistellungList(): AssistantAnswer {
  const docs = getAllDocuments().filter(documentMatchesFreistellung);
  if (docs.length === 0) return noDataAnswer('Freistellungsbescheinigungen');

  return withBullets(
    'Freistellungsbescheinigungen',
    `${docs.length} Freistellungsbescheinigung${docs.length === 1 ? '' : 'en'} im Archiv.`,
    docs.map((doc) => {
      const valid = doc.validUntil ? `, gültig bis ${doc.validUntil}` : '';
      return `${doc.title} – ${doc.issuer}${valid}`;
    }),
    [
      { id: 'documents', label: 'Dokumente öffnen', route: '/dokumente' },
      ...docs.map((doc) => ({
        id: doc.id,
        label: doc.title,
        route: `/dokumente/${doc.id}`,
      })),
    ],
    '/dokumente',
  );
}

function answerFreistellungLocation(): AssistantAnswer {
  const docs = getAllDocuments().filter(documentMatchesFreistellung);
  if (docs.length === 0) return noDataAnswer('Freistellungsbescheinigung');

  const doc = docs[0]!;
  if (docs.length === 1) {
    return withBullets(
      'Freistellungsbescheinigung',
      `Gefunden: ${doc.title}`,
      [
        `Digital: ${doc.digitalFolder.path}`,
        `Papier: ${doc.paperFolder.label}, Register ${doc.paperFolder.register}`,
      ],
      [
        { id: doc.id, label: 'Dokument öffnen', route: `/dokumente/${doc.id}` },
      ],
      `/dokumente/${doc.id}`,
    );
  }

  return withBullets(
    'Freistellungsbescheinigungen',
    `${docs.length} Freistellungsbescheinigungen im Archiv.`,
    docs.map(
      (d) =>
        `${d.title}: digital ${d.digitalFolder.path}, Papier ${d.paperFolder.label}`,
    ),
    docs.map((d) => ({
      id: d.id,
      label: d.title,
      route: `/dokumente/${d.id}`,
    })),
    `/dokumente/${docs[0]!.id}`,
  );
}

function answerMissingProofs(): AssistantAnswer {
  const missing = scanRequiredContractDocuments();
  if (missing.length === 0) return noDataAnswer('Fehlende Nachweise');

  return withBullets(
    'Fehlende Nachweise',
    `${missing.length} Nachweis${missing.length === 1 ? '' : 'e'} laut Vertragsanalyse nicht im Archiv.`,
    missing.map((item) => item.title),
    [
      { id: 'inbox', label: 'Eingang öffnen', route: '/eingang' },
      ...missing.map((item) => ({
        id: item.id,
        label: item.title,
        route: item.route,
      })),
    ],
    '/eingang',
  );
}

function answerWerkvertraege(): AssistantAnswer {
  const contracts: { title: string; route: string; type: string }[] = [];

  for (const item of filterActiveItems(getInboxItems())) {
    const analysis = analyzeContractFromInbox(item);
    if (!analysis.isContract) continue;
    if (
      analysis.contractType === 'werkvertrag' ||
      analysis.contractType === 'auftrag' ||
      analysis.contractType === 'bauvertrag' ||
      analysis.contractType === 'subunternehmervertrag'
    ) {
      contracts.push({
        title: item.title,
        route: `/eingang/${item.id}`,
        type: analysis.contractType ?? 'vertrag',
      });
    }
  }

  for (const doc of getAllDocuments()) {
    if (doc.category !== 'vertrag' && !/werkvertrag|bauvertrag|auftrag/i.test(doc.title)) {
      continue;
    }
    contracts.push({
      title: doc.title,
      route: `/dokumente/${doc.id}`,
      type: doc.category,
    });
  }

  if (contracts.length === 0) return noDataAnswer('Werkverträge');

  const unique = dedupeByRoute(contracts);
  return withBullets(
    'Werkverträge',
    `${unique.length} Werkvertrag${unique.length === 1 ? '' : 'e'} gefunden.`,
    unique.map((entry) => `${entry.title} (${entry.type})`),
    unique.map((entry, index) => ({
      id: `contract-${index}`,
      label: entry.title,
      route: entry.route,
    })),
  );
}

function dedupeByRoute<T extends { route: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.route)) return false;
    seen.add(item.route);
    return true;
  });
}

function answerOpenVorgaenge(): AssistantAnswer {
  const vorgaenge = getAllVorgaenge().filter(isOpenVorgang);
  if (vorgaenge.length === 0) return noDataAnswer('Offene Vorgänge');

  return withBullets(
    'Offene Vorgänge',
    `${vorgaenge.length} offene${vorgaenge.length === 1 ? 'r' : ''} Vorgang${vorgaenge.length === 1 ? '' : 'e'}.`,
    vorgaenge.map((v) => `${v.title} – ${v.customer}, Status: ${v.status}`),
    [
      { id: 'vorgaenge', label: 'Vorgänge öffnen', route: '/vorgaenge' },
      ...vorgaenge.map((v) => ({
        id: v.id,
        label: v.title,
        route: `/vorgaenge/${v.id}`,
      })),
    ],
    '/vorgaenge',
  );
}

function answerActiveBaustellen(): AssistantAnswer {
  const vorgaenge = getAllVorgaenge().filter(isOpenVorgang);
  if (vorgaenge.length === 0) return noDataAnswer('Aktive Baustellen');

  return withBullets(
    'Aktive Baustellen',
    `${vorgaenge.length} laufende Baustelle${vorgaenge.length === 1 ? '' : 'n'}.`,
    vorgaenge.map((v) => `${v.baustelle} – ${v.title} (${v.status})`),
    [
      { id: 'vorgaenge', label: 'Vorgänge öffnen', route: '/vorgaenge' },
      ...vorgaenge.map((v) => ({
        id: v.id,
        label: v.baustelle,
        route: `/vorgaenge/${v.id}`,
      })),
    ],
    '/vorgaenge',
  );
}

function answerUnpaidCustomers(todayIso: string): AssistantAnswer {
  const items = [...getOpenInvoices(todayIso), ...getOverdueInvoices(todayIso)];
  if (items.length === 0) return noDataAnswer('Offene Zahlungen');

  const byCustomer = new Map<string, InvoiceOverviewItem[]>();
  for (const item of items) {
    const list = byCustomer.get(item.customer) ?? [];
    list.push(item);
    byCustomer.set(item.customer, list);
  }

  const bullets = Array.from(byCustomer.entries()).map(([customer, invoices]) => {
    const open = invoices.reduce((sum, entry) => sum + entry.paymentSummary.openAmount, 0);
    return `${customer}: ${invoices.length} Rechnung${invoices.length === 1 ? '' : 'en'}, ${formatEuro(open)} offen`;
  });

  return withBullets(
    'Kunden mit offenen Zahlungen',
    `${byCustomer.size} Kunde${byCustomer.size === 1 ? '' : 'n'} mit offenen Rechnungen.`,
    bullets,
    [
      { id: 'open-invoices', label: 'Offene Rechnungen anzeigen', route: '/rechnungen/offen' },
      ...items.map(invoiceAction),
    ],
    '/rechnungen/offen',
  );
}

function answerOpenAmount(todayIso: string): AssistantAnswer {
  const totals = summarizeInvoiceOverview(getAllInvoiceOverview(todayIso));
  if (totals.openInvoiceCount === 0) return noDataAnswer('Offene Forderungen');

  return {
    title: 'Offene Forderungen',
    summary: `${formatEuro(totals.openReceivables)} offen bei ${totals.openInvoiceCount} Rechnung${totals.openInvoiceCount === 1 ? '' : 'en'}.`,
    bullets: [
      `Offene Forderungen gesamt: ${formatEuro(totals.openReceivables)}`,
      `Davon überfällig: ${formatEuro(totals.overdueReceivables)} (${totals.overdueInvoiceCount} Rechnung${totals.overdueInvoiceCount === 1 ? '' : 'en'})`,
    ],
    actions: [
      { id: 'open-invoices', label: 'Offene Rechnungen anzeigen', route: '/rechnungen/offen' },
    ],
    linkedRoute: '/rechnungen/offen',
  };
}

function answerPartialInvoices(todayIso: string): AssistantAnswer {
  const items = getPartialInvoices(todayIso);
  if (items.length === 0) return noDataAnswer('Teilbezahlte Rechnungen');

  return withBullets(
    'Teilbezahlte Rechnungen',
    `${items.length} teilbezahlte Rechnung${items.length === 1 ? '' : 'en'}.`,
    items.map((item) =>
      `${item.invoice.number} – ${item.customer}: ${formatEuro(item.paymentSummary.openAmount)} noch offen`,
    ),
    [
      { id: 'partial-invoices', label: 'Rechnungsübersicht öffnen', route: '/rechnungen/offen' },
      ...items.map(invoiceAction),
    ],
    '/rechnungen/offen',
  );
}

function answerDashboard(todayIso: string): AssistantAnswer {
  const { summary } = scanPendingItems(todayIso);
  const bullets: string[] = [];
  const actions: AssistantAction[] = [];

  if (summary.newInboxItems > 0) {
    bullets.push(`${summary.newInboxItems} neue Dokumente`);
    actions.push({ id: 'inbox', label: 'Eingang öffnen', route: '/eingang' });
  }
  if (summary.deferredInboxItems > 0) {
    bullets.push(`${summary.deferredInboxItems} zum Später klären`);
  }
  if (summary.overdueInvoices > 0) {
    bullets.push(`${summary.overdueInvoices} überfällige Rechnung${summary.overdueInvoices === 1 ? '' : 'en'}`);
    actions.push({ id: 'overdue', label: 'Rechnungen öffnen', route: '/rechnungen/offen' });
  }
  if (summary.dueTodayInvoices > 0) {
    bullets.push(`${summary.dueTodayInvoices} Rechnung${summary.dueTodayInvoices === 1 ? '' : 'en'} heute fällig`);
  }
  if (summary.expiringDocuments > 0) {
    bullets.push(`${summary.expiringDocuments} Nachweis${summary.expiringDocuments === 1 ? '' : 'e'} laufen bald ab`);
    actions.push({ id: 'documents', label: 'Dokumente öffnen', route: '/dokumente' });
  }
  if (summary.missingContractDocuments > 0) {
    bullets.push(`${summary.missingContractDocuments} fehlende Vertragsunterlage${summary.missingContractDocuments === 1 ? '' : 'n'}`);
  }
  if (summary.openTasks > 0) {
    bullets.push(`${summary.openTasks} offene Aufgaben`);
    actions.push({ id: 'tasks', label: 'Aufgaben öffnen', route: '/aufgaben' });
  }

  if (bullets.length === 0) return noDataAnswer('Heute wichtig');

  return withBullets(
    'Heute wichtig',
    'Das sollten Sie heute beachten:',
    bullets,
    actions,
    '/eingang',
  );
}
