/**
 * DOKUMENT-ASSISTENT-01F — gezielter Abruf von Betriebsdaten.
 *
 * Bis hierher beantwortete der Assistent jede Frage aus dem Dokument. Auf „Ist
 * das schon bezahlt?" konnte er deshalb nur sagen, dass das Schreiben dazu
 * nichts hergibt — obwohl OfficeTakt den Zahlungsstand kennt.
 *
 * Dieser Dienst schliesst die Lücke, ohne den Arbeitsbereich in den Prompt zu
 * kippen. Er erkennt an der Frage, **welche** Auskunft gebraucht wird, holt
 * genau diese aus dem vorhandenen Fachdienst und gibt sie als wenige Zeilen
 * zurück. Keine eigene Rechnung, keine zweite Wahrheit: Wo `Expense` und
 * `Task` die Wahrheit führen, werden sie gefragt.
 *
 * **Die Herkunft bleibt sichtbar.** Was das Dokument sagt und was OfficeTakt
 * weiss, sind zwei verschiedene Dinge — der Prompt trennt sie deshalb in zwei
 * Abschnitte, und diese Zeilen gehören ausschliesslich in den zweiten.
 */
import type { InboxItem } from '../../types/models';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { resolveDocumentFinanceReference } from '../documentFinanceReferenceService';
import { getVorgangById } from '../vorgangService';
import { getCustomerById } from '../customerStoreService';
import { getCommunicationHistorySnapshot } from '../communicationHistoryService';
import { getAllTasksFromStore } from '../taskStore';
import { isTaskOpen } from '../taskNormalize';

/** Welche Auskunft eine Frage verlangt. Mehrere zugleich sind möglich. */
export type RetrievalIntent = 'payment' | 'vorgang' | 'customer' | 'communication' | 'tasks';

const MUSTER: Record<RetrievalIntent, RegExp> = {
  payment:
    /(bezahlt|bezahlen wir|beglichen|offen|offener betrag|ausstehend|zahlungsstand|zahlungsstatus|überwiesen|ueberwiesen|teilzahlung|schon gezahlt)/i,
  vorgang: /(auftrag|vorgang|baustelle|projekt|bauvorhaben)/i,
  customer: /(kunde|kundin|auftraggeber|wer ist der kunde|gegenpartei)/i,
  communication:
    /(geschrieben|geantwortet|antwort geschickt|nachricht|korrespondenz|kontaktiert|gemeldet|e-?mail geschickt)/i,
  tasks: /(aufgabe|aufgaben|wiedervorlage|erinnerung|to-?do|todo|merker)/i,
};

/**
 * Welche Abrufe die Frage auslöst.
 *
 * Bewusst schlicht: Wortfelder, keine Absichtserkennung durch ein Modell. Eine
 * Fehlklassifikation kostet hier nur eine überflüssige Zeile im Prompt, nie
 * eine falsche Aussage — die Zeilen selbst kommen aus den Fachdiensten.
 */
export function detectRetrievalIntents(question: string): RetrievalIntent[] {
  const text = question ?? '';
  const treffer: RetrievalIntent[] = [];
  for (const [intent, muster] of Object.entries(MUSTER) as [RetrievalIntent, RegExp][]) {
    if (muster.test(text)) treffer.push(intent);
  }
  return treffer;
}

function euro(wert: number): string {
  return `${wert.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
}

function deutschesDatum(iso: string | undefined): string {
  if (!iso) return '';
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return t ? `${t[3]}.${t[2]}.${t[1]}` : iso;
}

const ZAHLUNGSSTAND: Record<string, string> = {
  open: 'offen',
  partial: 'teilweise bezahlt',
  paid: 'vollständig bezahlt',
  overdue: 'überfällig',
  cancelled: 'storniert',
};

/**
 * Der Zahlungsstand des **vorhandenen** Belegs, auf den sich das Schreiben
 * bezieht. Er stammt aus `Expense` und seinen Zahlungen, nie aus dem Dokument.
 */
function zahlungsZeilen(item: InboxItem): string[] {
  const treffer = resolveDocumentFinanceReference(item);

  if (treffer.status === 'not_found' || treffer.candidates.length === 0) {
    return [
      'Zu diesem Schreiben ist in OfficeTakt kein passender Beleg hinterlegt. Ein Zahlungsstand liegt deshalb nicht vor.',
    ];
  }
  if (treffer.status === 'ambiguous') {
    return [
      `In OfficeTakt kommen ${treffer.candidates.length} Belege in Frage; welcher gemeint ist, steht nicht fest. Ein Zahlungsstand lässt sich deshalb nicht nennen.`,
    ];
  }

  const beleg = treffer.matched ?? treffer.candidates[0];
  if (!beleg) return ['Zu diesem Schreiben ist in OfficeTakt kein passender Beleg hinterlegt.'];

  const zeilen = [
    `Zugehöriger Beleg in OfficeTakt: ${beleg.invoiceNumber || '(ohne Nummer)'} von ${beleg.supplierName || '(unbekannt)'}.`,
    `Zahlungsstand laut OfficeTakt: ${ZAHLUNGSSTAND[beleg.paymentStatus] ?? beleg.paymentStatus}.`,
    `Bereits bezahlt: ${euro(beleg.paidAmount)}. Noch offen: ${euro(beleg.openAmount)}.`,
  ];
  if (treffer.confirmed) zeilen.push('Die Verbindung zu diesem Beleg wurde bestätigt.');
  else zeilen.push('Die Verbindung zu diesem Beleg ist noch nicht bestätigt.');
  if (treffer.amountMismatch) {
    zeilen.push(
      'Der im Schreiben genannte Betrag weicht vom Beleg ab — bei Mahngebühren ist das normal.',
    );
  }
  return zeilen;
}

/**
 * Auftrag: Eine **bestätigte** Verknüpfung schlägt jeden Vorschlag. Ohne sie
 * bleiben die Kandidaten aus 01B, was sie sind — Vorschläge.
 */
function vorgangsZeilen(item: InboxItem, core: DocumentSemanticCore | undefined): string[] {
  const bestaetigt = item.vorgangId && item.vorgangLinkStatus === 'linked'
    ? getVorgangById(item.vorgangId)
    : undefined;
  if (bestaetigt) {
    const zeilen = [`Bestätigt zugeordneter Auftrag in OfficeTakt: ${bestaetigt.title}.`];
    if (bestaetigt.baustelle?.trim()) zeilen.push(`Baustelle: ${bestaetigt.baustelle}.`);
    if (bestaetigt.customer?.trim()) zeilen.push(`Kunde des Auftrags: ${bestaetigt.customer}.`);
    return zeilen;
  }
  if (!core || core.vorgangCandidates.length === 0) {
    return ['In OfficeTakt ist diesem Schreiben kein Auftrag zugeordnet.'];
  }
  return [
    'In OfficeTakt ist diesem Schreiben noch kein Auftrag zugeordnet. Es gibt nur unbestätigte Vorschläge.',
  ];
}

function kundenZeilen(item: InboxItem, core: DocumentSemanticCore | undefined): string[] {
  const vorgang = item.vorgangId ? getVorgangById(item.vorgangId) : undefined;
  const kunde = vorgang?.customerId ? getCustomerById(vorgang.customerId) : undefined;
  if (kunde) {
    return [`Bestätigt zugeordneter Kunde in OfficeTakt: ${kunde.name}.`];
  }
  if (!core || core.customerCandidates.length === 0) {
    return ['In OfficeTakt ist diesem Schreiben kein Kunde zugeordnet.'];
  }
  return [
    'In OfficeTakt ist diesem Schreiben noch kein Kunde zugeordnet. Es gibt nur unbestätigte Vorschläge.',
  ];
}

/** Höchstens so viele Einträge — der Prompt soll schlank bleiben. */
const MAX_EINTRAEGE = 3;

/**
 * Nur Kommunikation, die dieses Schreiben oder seinen Auftrag betrifft. Die
 * vollständige Historie hätte im Prompt nichts zu suchen.
 */
function kommunikationsZeilen(item: InboxItem): string[] {
  const alle = getCommunicationHistorySnapshot();
  const passend = alle.filter((eintrag) => {
    const ref = eintrag.contextRef as { type?: string; id?: string } | undefined;
    if (!ref?.id) return false;
    if (ref.id === item.id) return true;
    return Boolean(item.vorgangId && ref.id === item.vorgangId);
  });

  if (passend.length === 0) {
    return ['In OfficeTakt ist zu diesem Schreiben keine ausgehende Nachricht vermerkt.'];
  }
  const neueste = passend.slice(-MAX_EINTRAEGE).reverse();
  return [
    `In OfficeTakt sind ${passend.length} Vorgänge der Kommunikation vermerkt.`,
    ...neueste.map((eintrag) =>
      `${deutschesDatum(eintrag.timestamp)}: ${eintrag.channel ?? 'Nachricht'} (${eintrag.status}) — ${eintrag.resultExcerpt ?? eintrag.userInputExcerpt ?? ''}`.trim(),
    ),
  ];
}

/** Offene Aufgaben, die an diesem Schreiben oder seinem Auftrag hängen. */
function aufgabenZeilen(item: InboxItem): string[] {
  const passend = getAllTasksFromStore().filter((task) => {
    if (task.sync?.deleted) return false;
    if (!isTaskOpen(task)) return false;
    if (task.linkedInboxId === item.id) return true;
    if (task.linkedDocumentId && task.linkedDocumentId === item.archiveDocumentId) return true;
    return Boolean(item.vorgangId && task.linkedVorgangId === item.vorgangId);
  });

  if (passend.length === 0) {
    return ['In OfficeTakt ist zu diesem Schreiben keine offene Aufgabe hinterlegt.'];
  }
  return [
    `In OfficeTakt sind ${passend.length} offene Aufgaben dazu hinterlegt.`,
    ...passend.slice(0, MAX_EINTRAEGE).map(
      (task) => `${task.title}${task.dueDate ? ` (fällig ${deutschesDatum(task.dueDate)})` : ''}`,
    ),
  ];
}

export interface RetrievalInput {
  question: string;
  item: InboxItem;
  core?: DocumentSemanticCore;
}

/**
 * Die Betriebsdaten zu einer Frage — oder gar nichts.
 *
 * Fragt niemand danach, wird auch nichts geholt. Findet sich kein passender
 * Datensatz, sagen die Zeilen das ausdrücklich: Ein Schweigen wäre eine
 * Einladung, den Zahlungsstand aus dem Dokumenttext zu erfinden.
 */
export function buildOperationalLines(input: RetrievalInput): string[] {
  const intents = detectRetrievalIntents(input.question);
  if (intents.length === 0) return [];

  const zeilen: string[] = [];
  if (intents.includes('payment')) zeilen.push(...zahlungsZeilen(input.item));
  if (intents.includes('vorgang')) zeilen.push(...vorgangsZeilen(input.item, input.core));
  if (intents.includes('customer')) zeilen.push(...kundenZeilen(input.item, input.core));
  if (intents.includes('communication')) zeilen.push(...kommunikationsZeilen(input.item));
  if (intents.includes('tasks')) zeilen.push(...aufgabenZeilen(input.item));
  return zeilen;
}
