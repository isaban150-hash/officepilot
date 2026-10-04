import { getOverdueInvoices } from './invoiceOverviewService';
import { getClassificationForItem } from './documentClassificationService';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import {
  appendTaskToStore,
  findTasksInStore,
  getAllTasksFromStore,
  replaceTaskInStore,
  replaceTaskInStoreChecked,
} from './taskStore';
import {
  buildDedupeKey,
  getTodayIso,
  isTaskDone,
  isTaskOpen,
  mapTaskTypeToCategory,
  normalizeTask,
} from './taskNormalize';
import {
  generateEntityId,
  withTombstonedCloudEntityPreservingRemoteVersion,
} from './sync/syncMetaService';
import { isAuthorityClassifiedKind, isInsuranceClassifiedKind } from './businessInterpretationMeaning';
import { buildDocumentSemanticCore } from './document/documentSemanticCoreService';
import { getDocumentWorkResultForItem } from './documentWorkResultService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { getVorgangById } from './vorgangService';
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

/**
 * `null`, wenn der Vorschlag nicht dauerhaft gespeichert werden konnte.
 *
 * TAGESARBEIT-V1 — vorher gab diese Funktion die Aufgabe auch dann zurueck,
 * wenn `persistAll` fehlgeschlagen war; der Aufrufer hielt eine Aufgabe in
 * Haenden, die es nach dem Neuladen nicht mehr gab. Ein bereits vorhandener
 * Treffer der Entdopplung bleibt unveraendert ein Erfolg.
 */
export function createTaskFromProposal(proposal: TaskProposal): Task | null {
  const dedupeKey = buildDedupeKey(proposal);
  /*
   * TAGESARBEIT-V1 — ohne eigene Identität wird nicht entdoppelt.
   *
   * Fehlen **sowohl** ein ausdrücklicher `dedupeKey` als auch ein `sourceId`,
   * baut `buildDedupeKey` den Platzhalter `<sourceType>:none:<taskKind>` — ein
   * Schlüssel, der für jede Aufgabe derselben Art gleich ist und deshalb gar
   * keine Identität bezeichnet. Die zweite „Kunde anrufen" wäre wortlos
   * verschwunden.
   *
   * Bewusst **nicht** an `sourceType === 'manual'` festgemacht: Auch eine
   * Wiedervorlage ist `manual`, trägt aber ihren eigenen Schlüssel und soll
   * sehr wohl entdoppelt werden (`documentReminderProposalService`). Es geht
   * um das Vorhandensein einer Identität, nicht um die Quellart.
   *
   * `buildTaskIdentity` kennt dieselbe Unterscheidung bereits und liefert ohne
   * `sourceId` `null`; der dedupeKey-Weg tat es als einziger nicht. Cloud und
   * Server sind sich ebenfalls längst einig
   * (`hasStableCloudDedupeIdentity`, `workspace_tasks_active_auto_dedupe_idx`).
   */
  const traegtIdentitaet = Boolean(proposal.dedupeKey) || Boolean(proposal.sourceId);
  const existing = traegtIdentitaet ? findExistingOpenTaskByDedupeKey(dedupeKey) : null;
  if (existing) return { ...existing };
  const identity = buildTaskIdentity(proposal);
  const sameTask = identity ? findExistingOpenTaskByIdentity(identity) : null;
  if (sameTask) return { ...sameTask };

  const task = proposalToTask({ ...proposal, dedupeKey });
  const written = appendTaskToStore(task);
  return written.ok ? written.task : null;
}

export function createTasksFromProposals(proposals: TaskProposal[]): Task[] {
  return proposals
    .map((proposal) => createTaskFromProposal(proposal))
    .filter((task): task is Task => task !== null);
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

/* ------------------------------------------------------------------------ */
/* TAGESARBEIT-V1 — Aufgaben, die der Nutzer selbst führt                     */
/* ------------------------------------------------------------------------ */

/** Serverseitige Grenze aus `upsert_workspace_sync_entity`, hier gespiegelt. */
export const TASK_TITLE_MAX_LENGTH = 500;

export type TaskMutationResult =
  | { success: true; task: Task }
  | { success: false; errorKey: string };

export interface ManualTaskInput {
  title: string;
  description?: string;
  /** `YYYY-MM-DD`; leer oder `null` heisst „keine Frist". */
  dueDate?: string | null;
  /** Leer oder `null` heisst „kein Vorgangsbezug". */
  linkedVorgangId?: string | null;
}

/**
 * Was eine Bearbeitung ändern darf. Ein **fehlendes** Feld bleibt unberührt,
 * `null` entfernt es — der Unterschied ist hier fachlich wichtig, weil
 * „Frist nicht angefasst" und „Frist entfernt" zwei verschiedene Dinge sind.
 */
export interface TaskEditInput {
  title?: string;
  description?: string;
  dueDate?: string | null;
  linkedVorgangId?: string | null;
}

function normalizeTitle(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > TASK_TITLE_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Die Frist als lokaler Kalendertag `YYYY-MM-DD`.
 *
 * 03D — kein `toISOString()`-Weg: Der springt zwischen lokaler und
 * UTC-Mitternacht einen Tag zurück. `toCanonicalIsoDay` ist der vorhandene
 * Kanonisierer des Projekts; eine zweite Datumslogik entsteht hier nicht.
 *
 * Rückgabe: `undefined` = keine Frist, `null` = Eingabe unbrauchbar.
 */
function normalizeDueDate(value: string | null | undefined): string | undefined | null {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return toCanonicalIsoDay(trimmed) ?? null;
}

/** Vorgangsbezug: Kennung und Titel gehören zusammen — beide oder keiner. */
function resolveVorgangLink(
  vorgangId: string | null | undefined,
): { ok: true; id?: string; title?: string } | { ok: false } {
  if (vorgangId === null || vorgangId === undefined) return { ok: true };
  const trimmed = vorgangId.trim();
  if (!trimmed) return { ok: true };
  const vorgang = getVorgangById(trimmed);
  if (!vorgang) return { ok: false };
  return { ok: true, id: vorgang.id, title: vorgang.title };
}

/**
 * Legt eine Aufgabe an, die der Nutzer selbst formuliert hat.
 *
 * Bewusst **nicht** über `createTaskFromProposal`: Jene Funktion ist der
 * Ableitungsweg mit Entdopplung. Eine manuelle Aufgabe bekommt stattdessen
 * ihre **eigene** Quellkennung, womit ihr `dedupeKey` von vornherein einmalig
 * ist — zwei gleichlautende Notizen bleiben zwei Aufgaben, ohne dass dafür
 * irgendeine Entdopplung ausgeschaltet werden müsste.
 */
export function createManualTask(input: ManualTaskInput): TaskMutationResult {
  const title = normalizeTitle(input.title);
  if (!title) return { success: false, errorKey: 'task.error.titleInvalid' };

  const dueDate = normalizeDueDate(input.dueDate);
  if (dueDate === null) return { success: false, errorKey: 'task.error.dueDateInvalid' };

  const link = resolveVorgangLink(input.linkedVorgangId);
  if (!link.ok) return { success: false, errorKey: 'task.error.vorgangMissing' };

  const id = generateEntityId('t');
  const now = new Date().toISOString();
  const task = normalizeTask({
    id,
    title,
    description: input.description?.trim() ? input.description.trim() : title,
    status: 'open',
    priority: 'mittel',
    category: 'sonstiges',
    ...(dueDate ? { dueDate } : {}),
    ...(link.id ? { linkedVorgangId: link.id, linkedVorgangTitle: link.title } : {}),
    sourceType: 'manual',
    /* Eigene Quellkennung — siehe oben. */
    sourceId: id,
    taskKind: 'manual',
    dedupeKey: `manual:${id}:manual`,
    autoCreated: false,
    createdAt: now,
    type: 'dokument_pruefen',
  });

  const written = appendTaskToStore(task);
  if (!written.ok) return { success: false, errorKey: written.errorKey };
  return { success: true, task: written.task };
}

/**
 * Ändert Titel, Beschreibung, Frist und Vorgangsbezug — für manuelle **und**
 * automatisch erzeugte Aufgaben.
 *
 * `sync` bleibt unberührt (SYNC-VERSION-CONTRACT-02): `sync.version` ist
 * allein die zuletzt vom Server bestätigte `row_version`; ein selbst erhöhter
 * Wert endete im Versionskonflikt.
 */
export function updateTask(taskId: string, input: TaskEditInput): TaskMutationResult {
  let title: string | undefined;
  if (input.title !== undefined) {
    const normalized = normalizeTitle(input.title);
    if (!normalized) return { success: false, errorKey: 'task.error.titleInvalid' };
    title = normalized;
  }

  let dueDate: string | undefined;
  let clearDueDate = false;
  if (input.dueDate !== undefined) {
    const normalized = normalizeDueDate(input.dueDate);
    if (normalized === null) return { success: false, errorKey: 'task.error.dueDateInvalid' };
    if (normalized === undefined) clearDueDate = true;
    else dueDate = normalized;
  }

  let link: { id?: string; title?: string } | undefined;
  if (input.linkedVorgangId !== undefined) {
    const resolved = resolveVorgangLink(input.linkedVorgangId);
    if (!resolved.ok) return { success: false, errorKey: 'task.error.vorgangMissing' };
    link = { id: resolved.id, title: resolved.title };
  }

  const result = replaceTaskInStoreChecked(taskId, (task) => {
    const next: Task = { ...task };
    if (title !== undefined) next.title = title;
    if (input.description !== undefined) next.description = input.description.trim();
    if (clearDueDate) {
      /* Wirklich entfernen, nicht als Leerstring führen. */
      delete next.dueDate;
    } else if (dueDate !== undefined) {
      next.dueDate = dueDate;
    }
    if (link) {
      if (link.id) {
        next.linkedVorgangId = link.id;
        next.linkedVorgangTitle = link.title;
      } else {
        /* Kennung und Titel fallen gemeinsam — kein verwaister Vorgangstitel. */
        delete next.linkedVorgangId;
        delete next.linkedVorgangTitle;
        delete next.vorgangId;
        delete next.vorgangTitle;
      }
    }
    return next;
  });

  if (!result.ok) return { success: false, errorKey: result.errorKey };
  return { success: true, task: result.task };
}

/**
 * Löscht eine **manuelle** Aufgabe.
 *
 * Automatisch erzeugte Aufgaben haben keinen Löschweg: Sie entstehen aus einem
 * Beleg oder einer Frist und kämen bei der nächsten Ableitung ohnehin wieder;
 * „erledigt" ist dort die richtige Antwort. Geprüft wird das **hier**, nicht
 * erst in der Oberfläche.
 *
 * Gelöscht wird als Grabstein über den zum Sync-Vertrag passenden Helfer:
 * `withTombstonedCloudEntityPreservingRemoteVersion` lässt die bestätigte
 * Serverversion stehen, während `withTombstonedEntity` sie erhöhen und damit
 * einen Versionskonflikt auslösen würde.
 */
export function deleteManualTask(taskId: string): TaskMutationResult {
  const existing = getAllTasksFromStore().find((task) => task.id === taskId);
  if (!existing) return { success: false, errorKey: 'task.notFound' };
  if (existing.autoCreated !== false) {
    return { success: false, errorKey: 'task.error.autoNotDeletable' };
  }

  const result = replaceTaskInStoreChecked(taskId, (task) =>
    withTombstonedCloudEntityPreservingRemoteVersion(task, 'task'),
  );
  if (!result.ok) return { success: false, errorKey: result.errorKey };
  return { success: true, task: result.task };
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
      return all.filter(
        (task) => isTaskOpen(task) && task.dueDate && task.dueDate.slice(0, 10) < todayIso,
      );
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
  /*
   * TAGESARBEIT-V1 — derselbe Kalendertag wie im Filter.
   *
   * `getTasksFiltered('heute')` schnitt bereits auf zehn Zeichen ab, die
   * Kennzahl nicht. Traegt eine Frist einen Zeitanteil, zaehlte dieselbe
   * Aufgabe im Filter als heute, in der Kennzahl aber nicht. Neue Fristen
   * werden kanonisiert; der Altbestand wird hier gleich behandelt.
   */
  const dayOf = (value: string) => value.slice(0, 10);
  return {
    open: openTasks.length,
    today: openTasks.filter((t) => t.dueDate && dayOf(t.dueDate) <= todayIso).length,
    overdue: openTasks.filter((t) => t.dueDate && dayOf(t.dueDate) < todayIso).length,
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
