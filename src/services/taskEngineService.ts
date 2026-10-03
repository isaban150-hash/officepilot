import { getOverdueInvoices } from './invoiceOverviewService';
import { getClassificationForItem } from './documentClassificationService';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import {
  appendTaskToStore,
  findTasksInStore,
  getAllTasksFromStore,
  replaceTaskInStore,
} from './taskStore';
import {
  buildDedupeKey,
  getTodayIso,
  isTaskDone,
  isTaskOpen,
  mapTaskTypeToCategory,
  normalizeTask,
} from './taskNormalize';
import { generateEntityId } from './sync/syncMetaService';
import { isAuthorityClassifiedKind, isInsuranceClassifiedKind } from './businessInterpretationMeaning';
import { buildDocumentSemanticCore } from './document/documentSemanticCoreService';
import { getDocumentWorkResultForItem } from './documentWorkResultService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import {
  formatDunningAmount,
  resolveDunningFinanceTruth,
  type DunningFinanceState,
  type DunningFinanceTruth,
} from './document/dunningFinanceTruth';
import {
  buildComplaintTaskDescription,
  COMPLAINT_OBLIGATION_TITLE,
  COMPLAINT_TASK_TITLE,
  resolveComplaint,
  resolveComplaintAction,
} from './document/complaintTruth';
import { toCanonicalIsoDay } from '../utils/documentDateDisplay';
import type { BusinessDeadlineType } from '../types/businessInterpretation';
import type { DocumentSemanticCore, SemanticObligation } from '../types/documentSemanticCore';
import type {
  ClassifiedDocumentKind,
  CompanyProfile,
  ContractAnalysisResult,
  InboxItem,
  InboxTaskTemplate,
  RequiredDocument,
  Task,
  TaskCategory,
  TaskFilter,
  TaskProposal,
  TaskSummary,
  TaskType,
} from '../types/models';

export {
  buildDedupeKey,
  getTodayIso,
  isTaskDone,
  isTaskOpen,
  normalizeTask,
} from './taskNormalize';

function mapRequiredDocToCategory(docType: string): TaskCategory {
  if (docType === 'freistellungsbescheinigung') return 'steuern';
  return 'behoerden';
}

function baseInboxLinks(item: InboxItem) {
  return {
    linkedInboxId: item.id,
    linkedVorgangId: item.vorgangId,
    linkedVorgangTitle: item.vorgangTitle,
  };
}

/**
 * CLOUD-DURABILITY-CORE-01C — der Dedupe-Treffer der Engine.
 *
 * Zwei Ergänzungen gegenüber vorher, beide notwendig, damit die Cloud-Fassung
 * sich richtig verhält:
 *
 *  * Ein Grabstein ist **kein** Treffer. Sonst hielte eine anderswo entfernte
 *    Aufgabe die Neuanlage dauerhaft auf, und der Arbeitsvorrat verschwände
 *    still.
 *  * Eine bereits aus der Cloud gezogene kanonische Aufgabe ist einer: Sie
 *    liegt mit demselben `dedupeKey` im Bestand, und genau daran erkennt die
 *    Engine, dass sie nichts Neues erzeugen muss.
 *
 * Die fachliche Regel bleibt unangetastet: Erledigte und archivierte Aufgaben
 * blockieren eine spätere neue Episode nicht.
 */
export function findExistingOpenTaskByDedupeKey(dedupeKey: string): Task | null {
  const match = findTasksInStore(
    (task) => task.dedupeKey === dedupeKey && isTaskOpen(task) && !task.sync?.deleted,
  );
  return match[0] ?? null;
}

/* EINGANG-02B — Prüfaufgabe je bekanntem Finanzstand einer Mahnung; nie „zahlen". */
const DUNNING_TASK_TITLE: Record<DunningFinanceState, string> = {
  open: 'Mahnung/Forderung prüfen',
  paid: 'Mahnung gegen Zahlungsstatus prüfen',
  partially_paid: 'Restforderung prüfen',
  reference_unclear: 'Rechnungsbezug prüfen',
  court: 'Mahnbescheid prüfen',
};

function buildDunningTaskDescription(titel: string, mahnung: DunningFinanceTruth): string {
  const zeilen = [titel];
  if (mahnung.invoiceNumber) zeilen.push(`Bezug: ${mahnung.invoiceNumber}`);
  if (mahnung.claimAmount !== undefined) zeilen.push(`Forderung laut Mahnung: ${formatDunningAmount(mahnung.claimAmount)}`);
  if (mahnung.invoiceNumber && mahnung.paidAmount !== undefined) zeilen.push(`Bezahlt laut OfficeTakt: ${formatDunningAmount(mahnung.paidAmount)}`);
  if (mahnung.invoiceNumber && mahnung.openAmount !== undefined) zeilen.push(`Offen laut OfficeTakt: ${formatDunningAmount(mahnung.openAmount)}`);
  return zeilen.join('\n');
}

export function proposeTasksFromClassification(
  item: InboxItem,
  profile?: CompanyProfile,
): TaskProposal[] {
  if (!isDocumentAnalysisAllowed(item, profile)) return [];

  const classification = getClassificationForItem(item);
  const kind = classification.classifiedKind;
  const dueDate =
    toCanonicalIsoDay(item.deadline) ?? toCanonicalIsoDay(classification.deadline) ?? undefined;
  const links = baseInboxLinks(item);
  const proposals: TaskProposal[] = [];

  const push = (proposal: Omit<TaskProposal, 'sourceType' | 'sourceId'> & { taskKind: string }) => {
    proposals.push({
      ...links,
      sourceType: 'classification',
      sourceId: item.id,
      autoCreated: false,
      ...proposal,
    });
  };

  if (kind === 'mahnung' || kind === 'zahlungserinnerung') {
    /*
     * EINGANG-02B — Titel und Hinweis folgen dem bekannten Finanzstand (Bezug,
     * bezahlt, Rest). Dieselbe Aufgabenidentität wie bisher (`payment_check`),
     * damit Ablegen, manuelles Anlegen und neue Analyse nichts verdoppeln.
     */
    const mahnung = resolveDunningFinanceTruth(item, semanticCoreForItem(item));
    const titel = mahnung ? DUNNING_TASK_TITLE[mahnung.state] : 'Zahlung prüfen';
    push({
      title: titel,
      description: mahnung
        ? buildDunningTaskDescription(classification.title, mahnung)
        : `${classification.title} – offenen Betrag prüfen`,
      priority: 'kritisch',
      category: 'zahlungen',
      ...(mahnung?.state === 'court' ? {} : { dueDate }),
      taskKind: 'payment_check',
      type: 'dokument_pruefen',
    });
  }

  if (['bg_bau', 'aok', 'soka_bau', 'finanzamt'].includes(kind)) {
    push({
      title: 'Behörden-Schreiben prüfen',
      description: classification.explanation,
      priority: kind === 'finanzamt' ? 'hoch' : 'mittel',
      category: 'behoerden',
      dueDate,
      taskKind: `authority_review:${kind}`,
      type: 'dokument_pruefen',
    });
  }

  if (kind === 'freistellungsbescheinigung') {
    push({
      title: 'Gültigkeit der Freistellungsbescheinigung prüfen',
      description: classification.explanation,
      priority: 'hoch',
      category: 'steuern',
      dueDate: toCanonicalIsoDay(item.recognizedData.Gültig_bis) ?? dueDate,
      taskKind: 'monitor_freistellung_validity',
      type: 'steuerberater_export',
    });
    push({
      title: 'Freistellungsbescheinigung an Auftraggeber senden',
      description: 'Bescheinigung bereithalten und Versand nach Bestätigung vorbereiten',
      priority: 'mittel',
      category: 'steuern',
      taskKind: 'send_freistellung_to_client',
      type: 'steuerberater_export',
    });
  }

  if (kind === 'abnahmeprotokoll') {
    push({
      title: 'Schlussrechnung prüfen',
      description: 'Abnahmeprotokoll vorhanden – Vorgang abschließen und Schlussrechnung vorbereiten',
      priority: 'hoch',
      category: 'rechnungen',
      dueDate,
      taskKind: 'review_schlussrechnung',
      type: 'rechnung_vorbereiten',
    });
  }

  return proposals;
}

export function proposeTaskFromInboxTemplate(
  item: InboxItem,
  template: InboxTaskTemplate,
  options: { autoCreated?: boolean } = {},
): TaskProposal {
  return {
    title: template.title,
    description: template.description,
    priority: item.priority,
    category: mapTaskTypeToCategory(template.type),
    dueDate: toCanonicalIsoDay(template.dueDate) ?? toCanonicalIsoDay(item.deadline) ?? undefined,
    linkedInboxId: item.id,
    linkedVorgangId: item.vorgangId ?? template.vorgangId,
    linkedVorgangTitle: item.vorgangTitle ?? template.vorgangTitle,
    sourceType: 'inbox',
    sourceId: item.id,
    taskKind: `inbox_template:${template.type}`,
    dedupeKey: `inbox:${item.id}:follow_up`,
    autoCreated: options.autoCreated ?? false,
    type: template.type,
  };
}

/**
 * EINGANG-02A-2B — ein Behörden- oder Versicherungsschreiben, das ausdrücklich
 * nur informiert („Von Ihnen ist nichts weiter zu veranlassen") und weder
 * eigene Pflicht noch Handlungsfrist noch relative Frist trägt.
 *
 * Bewusst eng: nur diese beiden Familien, nur ohne kanonische Frist und nur mit
 * dem Informationshinweis des semantischen Kerns. Rechnungen, Mahnungen,
 * Verträge, Angebote und Gutschriften sind nie betroffen; „kein Datum" allein
 * genügt nie. Ohne Text und ohne gespeicherten Kern bleibt alles wie bisher.
 */
export function isPureInstitutionalInformation(item: InboxItem): boolean {
  const kind = item.classifiedKind;
  if (!kind || !(isAuthorityClassifiedKind(kind) || isInsuranceClassifiedKind(kind))) return false;
  if (item.deadline?.trim()) return false;
  return Boolean(semanticCoreForItem(item)?.informationOnly);
}

/**
 * Der semantische Kern eines Eingangs — derselbe Leser wie in der Analyse, aus
 * dem Volltext; ohne Text der gespeicherte Kern des Arbeitsstands. Keine
 * zweite Fristen- oder Pflichtenerkennung.
 */
function semanticCoreForItem(item: InboxItem): DocumentSemanticCore | null | undefined {
  const text = getInboxExtractedDocumentText(item);
  return text
    ? buildDocumentSemanticCore({ text, companyProfile: null })
    : getDocumentWorkResultForItem(item.id)?.businessInterpretation?.semantic;
}

/* ------------------------------------------------------------------ */
/* EINGANG-02A-2C — eine Aufgabe je eigener Pflicht                    */
/* ------------------------------------------------------------------ */

const OBLIGATION_TASK: Record<BusinessDeadlineType, { title: string; category?: TaskCategory }> = {
  response_due: { title: 'Stellungnahme abgeben' },
  document_submission_due: { title: 'Unterlagen einreichen' },
  /* Nur prüfen — gezahlt, erfasst oder gebucht wird nichts. */
  payment_due: { title: 'Zahlung prüfen', category: 'zahlungen' },
  service_due: { title: 'Leistung erbringen' },
  termination_notice: { title: 'Kündigungsfrist prüfen' },
};

/** Stabile fachliche Identität einer Pflicht: Art und Datum bzw. Fristwortlaut. */
function obligationTaskKey(obligation: SemanticObligation): string {
  const wann = obligation.byWhen
    ? obligation.byWhen
    : obligation.relativeDeadline
      ? `relativ-${obligation.relativeDeadline.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}`
      : 'ohne-frist';
  return `${obligation.kind}:${wann}`;
}

/**
 * EINGANG-02A-2C — mehrere eigene Pflichten eines Behörden-, Versicherungs-
 * oder sonstigen Schreibens werden zu mehreren konkreten Vorschlägen: je
 * Art und Frist ein Titel, das eigene Datum (nie die Hauptfrist für alle), die
 * relative Frist im Wortlaut ohne berechnetes Datum und die angeforderten
 * Unterlagen. Gibt es weniger als zwei solche Pflichten, bleibt es beim
 * bisherigen einzelnen Vorschlag — leere Liste.
 *
 * Rechnungen, Mahnungen, Gutschriften, Verträge und Angebote haben ihren
 * eigenen Weg und sind nicht betroffen. Nichts davon handelt nach aussen.
 */
export function proposeObligationTasks(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): TaskProposal[] {
  if (!isDocumentAnalysisAllowed(item, profile)) return [];
  const kind = item.classifiedKind;
  if (kind && kind !== 'sonstiges' && !isAuthorityClassifiedKind(kind) && !isInsuranceClassifiedKind(kind)) return [];
  const core = semanticCoreForItem(item);
  if (!core) return [];
  /* EINGANG-02C — Pflichten einer eingehenden Beschwerde: prüfen/vorbereiten, Kategorie Dokumente. */
  const beschwerde = resolveComplaint(item, core);

  /*
   * Nacharbeit 1 — gleiche Art und gleiche Frist sind dieselbe interne
   * Handlung („Unterlagen einreichen bis 25.10."). Sie werden zu einer Aufgabe
   * gruppiert, ohne dass eine Pflicht verloren geht: alle Pflichttexte, alle
   * Unterlagen (identische nur einmal), alle relativen Fristen. Der Schlüssel
   * bleibt fachlich (Art + Frist) — kein Index, damit eine spätere Analyse in
   * anderer Reihenfolge dieselbe Aufgabe wiederfindet.
   */
  interface Gruppe {
    key: string;
    kind: BusinessDeadlineType;
    byWhen?: string;
    texte: string[];
    unterlagen: string[];
    relativ: string[];
  }
  const gruppen = new Map<string, Gruppe>();
  let pflichten = 0;
  core.obligations.forEach((obligation, index) => {
    if (obligation.who !== 'own_company' || !obligation.kind) return;
    pflichten += 1;
    const key = obligationTaskKey(obligation);
    const gruppe =
      gruppen.get(key) ??
      ({ key, kind: obligation.kind, byWhen: obligation.byWhen, texte: [], unterlagen: [], relativ: [] } satisfies Gruppe);
    gruppen.set(key, gruppe);
    if (!gruppe.texte.includes(obligation.what)) gruppe.texte.push(obligation.what);
    for (const doc of core.requestedDocuments ?? []) {
      if (doc.obligationIndex !== index) continue;
      if (!gruppe.unterlagen.some((label) => label.toLowerCase() === doc.label.toLowerCase())) gruppe.unterlagen.push(doc.label);
    }
    if (obligation.relativeDeadline && !gruppe.relativ.includes(obligation.relativeDeadline)) {
      gruppe.relativ.push(obligation.relativeDeadline);
    }
  });
  /* Erst ab zwei eigenen Pflichten — auch wenn sie in einer Gruppe landen, damit nichts im Einzelfallback verschwindet. */
  if (pflichten < 2) return [];

  return [...gruppen.values()].map((gruppe) => {
    const vorlage = beschwerde
      ? { title: COMPLAINT_OBLIGATION_TITLE[gruppe.kind] ?? OBLIGATION_TASK[gruppe.kind].title, category: 'dokumente' as TaskCategory }
      : OBLIGATION_TASK[gruppe.kind];
    const hinweise = [
      ...gruppe.texte,
      gruppe.unterlagen.length > 0 ? `Unterlagen: ${gruppe.unterlagen.join(', ')}` : '',
      ...gruppe.relativ.map((phrase) => `Frist laut Schreiben: ${phrase} – Datum nicht berechnet, bitte prüfen.`),
      !gruppe.byWhen && gruppe.relativ.length === 0 ? 'Keine Frist genannt – bitte prüfen.' : '',
    ].filter(Boolean);
    return {
      title: vorlage.title,
      description: hinweise.join('\n'),
      priority: item.priority,
      category: vorlage.category ?? (kind && isInsuranceClassifiedKind(kind) ? 'versicherungen' : 'behoerden'),
      ...(gruppe.byWhen ? { dueDate: gruppe.byWhen } : {}),
      ...baseInboxLinks(item),
      sourceType: 'inbox',
      sourceId: item.id,
      taskKind: `obligation:${gruppe.key}`,
      dedupeKey: `inbox:${item.id}:obligation:${gruppe.key}`,
      autoCreated: options.autoCreated ?? false,
      type: 'dokument_pruefen',
    } satisfies TaskProposal;
  });
}

/**
 * EINGANG-02A-2C — alle Vorschläge, die ein Eingang beim Ablegen bzw. auf
 * ausdrücklichen Wunsch erzeugt: bei mehreren eigenen Pflichten je Pflicht
 * einer, sonst unverändert der eine bisherige Vorschlag.
 */
export function proposeInboxTasks(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): TaskProposal[] {
  if (!isDocumentAnalysisAllowed(item, profile)) return [];
  if (options.autoCreated && isPureInstitutionalInformation(item)) return [];
  const proPflicht = proposeObligationTasks(item, profile, options);
  if (proPflicht.length > 0) return proPflicht;
  const primary = proposePrimaryInboxTask(item, profile, options);
  return primary ? [primary] : [];
}

export function proposePrimaryInboxTask(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): TaskProposal | null {
  if (!isDocumentAnalysisAllowed(item, profile)) return null;
  /*
   * EINGANG-02A-2B — beim Ablegen entsteht für reine Information keine
   * Wiedervorlage allein aus der Dokumentart. Wer ausdrücklich eine Aufgabe
   * anlegt, bekommt sie weiterhin.
   */
  if (options.autoCreated && isPureInstitutionalInformation(item)) return null;

  /*
   * EINGANG-02C — eine eingehende Beschwerde mit höchstens einer eigenen
   * Pflicht bekommt genau eine Prüfaufgabe (statt keiner, weil die Grundart
   * neutral ist). Ein eigenes Schreiben erzeugt keine eigene Aufgabe.
   */
  const beschwerde = resolveComplaint(item, semanticCoreForItem(item));
  if (beschwerde) {
    if (beschwerde.direction === 'outgoing') return null;
    const handlung = resolveComplaintAction(beschwerde, semanticCoreForItem(item), item.deadlineType);
    return {
      title: COMPLAINT_TASK_TITLE[handlung],
      description: buildComplaintTaskDescription(beschwerde),
      priority: item.priority,
      category: 'dokumente',
      ...(item.deadline ? { dueDate: item.deadline } : {}),
      ...baseInboxLinks(item),
      sourceType: 'inbox',
      sourceId: item.id,
      taskKind: 'complaint_check',
      dedupeKey: `inbox:${item.id}:complaint`,
      autoCreated: options.autoCreated ?? false,
      type: 'dokument_pruefen',
    } satisfies TaskProposal;
  }

  const classificationProposals = proposeTasksFromClassification(item, profile);
  if (classificationProposals.length > 0) {
    return {
      ...classificationProposals[0],
      dedupeKey: `inbox:${item.id}:follow_up`,
      autoCreated: options.autoCreated ?? false,
    };
  }

  if (!item.taskTemplate) return null;
  return proposeTaskFromInboxTemplate(item, item.taskTemplate, options);
}

export function proposeTasksFromContract(
  analysis: ContractAnalysisResult,
  inboxId: string,
): TaskProposal[] {
  if (!analysis.isContract || analysis.requiredDocuments.length === 0) return [];

  return analysis.requiredDocuments.map((doc: RequiredDocument) => ({
    title: `Nachweis beschaffen: ${doc.type.replace(/_/g, ' ')}`,
    description: doc.reason,
    priority: doc.priority,
    category: mapRequiredDocToCategory(doc.type),
    linkedInboxId: inboxId,
    sourceType: 'contract',
    sourceId: inboxId,
    taskKind: `required_doc:${doc.type}`,
    autoCreated: false,
    type: 'dokument_pruefen' as TaskType,
  }));
}

export function proposeTasksFromOverdueInvoices(today?: Date | string): TaskProposal[] {
  return getOverdueInvoices(today).map((entry) => ({
    title: `Zahlung prüfen: Rechnung ${entry.invoice.number}`,
    description: `Überfällige Ausgangsrechnung für ${entry.customer} – offener Betrag ${entry.paymentSummary.openAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
    priority: entry.paymentSummary.openAmount >= 1000 ? ('kritisch' as const) : ('hoch' as const),
    category: 'zahlungen' as TaskCategory,
    dueDate: entry.invoice.paymentDueDate,
    // 01B2c — ohne Auftrag bleibt der Vorgangsbezug der Aufgabe leer; die
    // Rechnungskennung trägt den Bezug.
    linkedVorgangId: entry.vorgangId ?? undefined,
    linkedVorgangTitle: entry.vorgangId === null ? undefined : entry.vorgangTitle,
    linkedInvoiceId: entry.invoice.id,
    sourceType: 'invoice',
    sourceId: entry.invoice.id,
    taskKind: 'payment_overdue',
    autoCreated: true,
    type: 'dokument_pruefen' as TaskType,
  }));
}

function proposalToTask(proposal: TaskProposal): Task {
  const dedupeKey = buildDedupeKey(proposal);
  const now = new Date().toISOString();
  /*
   * CLOUD-DURABILITY-CORE-01C / SYNC-VERSION-CONTRACT-02 — die neue Aufgabe
   * bekommt **keine** Sync-Meta.
   *
   * `sync.version` ist ausschliesslich die zuletzt vom Server bestaetigte
   * `row_version`. Der bisherige Startwert 1 aus `withNewEntitySync` war eine
   * Behauptung, die der Server nie bestaetigt hat; der erste Push traete damit
   * mit einer falschen Erwartung an. Der Weg in die Cloud fuehrt unveraendert
   * ueber den Change-Tracker.
   */
  return (
    normalizeTask({
      id: generateEntityId('t'),
      title: proposal.title,
    description: proposal.description,
    status: 'open',
    priority: proposal.priority,
    category: proposal.category,
    dueDate: proposal.dueDate,
    linkedVorgangId: proposal.linkedVorgangId,
    linkedVorgangTitle: proposal.linkedVorgangTitle,
    linkedInboxId: proposal.linkedInboxId,
    linkedDocumentId: proposal.linkedDocumentId,
    linkedInvoiceId: proposal.linkedInvoiceId,
    sourceType: proposal.sourceType,
    sourceId: proposal.sourceId,
    taskKind: proposal.taskKind,
    dedupeKey,
    autoCreated: proposal.autoCreated ?? false,
    createdAt: now,
    type: proposal.type ?? 'dokument_pruefen',
    })
  );
}

/**
 * EINGANG-01A (P1) — die fachliche Identität einer vorgeschlagenen Aufgabe:
 * Quelle + Quellobjekt + Aufgabenart. Dieselbe Aufgabe kam bisher unter zwei
 * Schlüsseln an (`classification:<id>:payment_check` und, als Hauptaufgabe
 * umbenannt, `inbox:<id>:follow_up`) und entstand dann zweimal. Ohne
 * Quellobjekt und bei manuellen Aufgaben gibt es keine solche Identität.
 */
export function buildTaskIdentity(
  proposal: Pick<TaskProposal, 'sourceType' | 'sourceId' | 'taskKind'>,
): string | null {
  if (!proposal.sourceId || proposal.sourceType === 'manual') return null;
  return `${proposal.sourceType}|${proposal.sourceId}|${proposal.taskKind}`;
}

function findExistingOpenTaskByIdentity(identity: string): Task | null {
  const match = findTasksInStore(
    (task) => buildTaskIdentity(task) === identity && isTaskOpen(task) && !task.sync?.deleted,
  );
  return match[0] ?? null;
}

export function createTaskFromProposal(proposal: TaskProposal): Task {
  const dedupeKey = buildDedupeKey(proposal);
  const existing = findExistingOpenTaskByDedupeKey(dedupeKey);
  if (existing) return { ...existing };
  const identity = buildTaskIdentity(proposal);
  const sameTask = identity ? findExistingOpenTaskByIdentity(identity) : null;
  if (sameTask) return { ...sameTask };

  const task = proposalToTask({ ...proposal, dedupeKey });
  appendTaskToStore(task);
  return { ...task };
}

export function createTasksFromProposals(proposals: TaskProposal[]): Task[] {
  return proposals.map((proposal) => createTaskFromProposal(proposal));
}

export function createTaskFromInboxItem(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): Task | null {
  return createTasksFromInboxItem(item, profile, options)[0] ?? null;
}

/**
 * EINGANG-02A-2C — legt alle Vorschläge eines Eingangs an (eine Aufgabe je
 * eigener Pflicht, sonst die eine bisherige). Die bestehende Dedupe über
 * `dedupeKey` und Identität macht wiederholtes Ablegen idempotent.
 */
export function createTasksFromInboxItem(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): Task[] {
  return createTasksFromProposals(proposeInboxTasks(item, profile, options));
}

export function createTasksFromContractAnalysis(
  analysis: ContractAnalysisResult,
  inboxId: string,
): Task[] {
  return createTasksFromProposals(proposeTasksFromContract(analysis, inboxId));
}

export function syncOverdueInvoiceTasks(today?: Date | string): Task[] {
  return createTasksFromProposals(proposeTasksFromOverdueInvoices(today));
}

export function completeTask(taskId: string): Task | null {
  return replaceTaskInStore(taskId, (task) => {
    if (!isTaskOpen(task)) return task;
    return normalizeTask({
      ...task,
      status: 'done',
      completedAt: new Date().toISOString(),
      done: true,
    });
  });
}

export function reopenTask(taskId: string): Task | null {
  return replaceTaskInStore(taskId, (task) => {
    if (task.status !== 'done') return task;
    return normalizeTask({
      ...task,
      status: 'open',
      completedAt: undefined,
      done: false,
    });
  });
}

export function archiveTask(taskId: string): Task | null {
  return replaceTaskInStore(taskId, (task) =>
    normalizeTask({
      ...task,
      status: 'archived',
      completedAt: task.completedAt ?? new Date().toISOString(),
      done: true,
    }),
  );
}

export function toggleTaskCompletion(taskId: string): Task | null {
  const task = getAllTasksFromStore().find((t) => t.id === taskId);
  if (!task) return null;
  if (isTaskOpen(task)) return completeTask(taskId);
  if (task.status === 'done') return reopenTask(taskId);
  return task;
}

export function getTasksFiltered(
  filter: TaskFilter,
  today: Date | string = new Date(),
): Task[] {
  const todayIso = getTodayIso(today);
  const all = getAllTasksFromStore();

  switch (filter) {
    case 'offen':
      return all.filter(isTaskOpen);
    case 'heute':
      // 01D — „Heute“ heißt heute fällig; Überfälliges hat seinen eigenen Filter.
      return all.filter((task) => isTaskOpen(task) && task.dueDate && task.dueDate.slice(0, 10) === todayIso);
    case 'ueberfaellig':
      return all.filter((task) => isTaskOpen(task) && task.dueDate && task.dueDate < todayIso);
    case 'kritisch':
      return all.filter((task) => isTaskOpen(task) && task.priority === 'kritisch');
    case 'erledigt':
      return all.filter(isTaskDone);
    default:
      return all;
  }
}

export function getTaskSummary(today: Date | string = new Date()): TaskSummary {
  const todayIso = getTodayIso(today);
  const all = getAllTasksFromStore();
  const openTasks = all.filter(isTaskOpen);
  return {
    open: openTasks.length,
    today: openTasks.filter((t) => t.dueDate && t.dueDate <= todayIso).length,
    overdue: openTasks.filter((t) => t.dueDate && t.dueDate < todayIso).length,
    critical: openTasks.filter((t) => t.priority === 'kritisch').length,
    done: all.filter(isTaskDone).length,
    total: all.length,
  };
}

export function isClassificationKindWithTasks(kind: ClassifiedDocumentKind): boolean {
  return (
    kind === 'mahnung' ||
    kind === 'zahlungserinnerung' ||
    kind === 'freistellungsbescheinigung' ||
    kind === 'abnahmeprotokoll' ||
    ['bg_bau', 'aok', 'soka_bau', 'finanzamt'].includes(kind)
  );
}
