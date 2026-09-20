/**
 * DOKUMENT-ASSISTENT-01F — Wiedervorlagen vorschlagen, nicht anlegen.
 *
 * Eine Dokumentfrist und eine Wiedervorlage sind zwei verschiedene Dinge, und
 * sie dürfen sich nie vermischen:
 *
 *   `semantic.deadlines[]` — was im Schreiben steht. Erkannte Tatsache,
 *                            unveränderlich, nur lesend.
 *   `Task`                 — was der Betrieb sich vornimmt. Entscheidung des
 *                            Benutzers, jederzeit änderbar.
 *
 * Deshalb verändert eine Wiedervorlage den semantischen Kern nicht, und der
 * Titel der Aufgabe nennt die Frist ausdrücklich mit: So bleibt sichtbar, dass
 * die Erinnerung am 20.09. an eine Frist am 22.09. erinnert.
 *
 * **Gerechnet wird hier, nicht im Sprachmodell.** „Zwei Tage vorher" ist eine
 * Subtraktion; ein Modell, das sie rät, hat schon verloren.
 *
 * Es entsteht **kein** neues Modell: Der Vorschlag ist ein `TaskProposal`, wie
 * ihn OfficeTakt für Aufgabenvorschläge längst kennt, und das Anlegen läuft
 * über `createTaskFromProposal` — samt dessen Dedupe.
 */
import type { InboxItem, Task, TaskProposal } from '../../types/models';
import type { DocumentSemanticCore, SemanticDeadline } from '../../types/documentSemanticCore';
import { createTaskFromProposal, findExistingOpenTaskByDedupeKey } from '../taskEngineService';
import { getVorgangById } from '../vorgangService';

/** Wie der Benutzer den Termin der Erinnerung ausgedrückt hat. */
export type ReminderTiming =
  | { kind: 'on_deadline' }
  | { kind: 'days_before'; days: number }
  | { kind: 'fixed_date'; date: string };

export interface ReminderProposal {
  /** Der fertige Vorschlag — noch nicht angelegt. */
  proposal: TaskProposal;
  /** Das Datum der Erinnerung, ISO. */
  remindOn: string;
  /** Die Frist aus dem Schreiben, auf die sich die Erinnerung bezieht. */
  deadline: SemanticDeadline;
  /** Besteht die Wiedervorlage schon? Dann legt die Bestätigung nichts Neues an. */
  alreadyExists: boolean;
}

/** Mehrere Fristen kommen in Frage — OfficeTakt darf nicht raten. */
export interface ReminderNeedsChoice {
  kind: 'needs_choice';
  /** Die Fristen zur Auswahl, in der Reihenfolge ihres Datums. */
  options: SemanticDeadline[];
}

export type ReminderProposalResult =
  | { kind: 'proposal'; value: ReminderProposal }
  | ReminderNeedsChoice
  | { kind: 'no_deadline' }
  | { kind: 'not_a_reminder' };

/* ------------------------------------------------------------------ */
/* Absicht und Zeitpunkt aus der Eingabe                               */
/* ------------------------------------------------------------------ */

const ERINNERUNG =
  /(erinnere?\s+mich|erinnerung|wiedervorlage|nochmal\s+melden|merk\s+dir|auf\s+wiedervorlage)/i;

const TAGE_VORHER = /(\d+|einen?|zwei|drei|vier|fünf|fuenf|sieben|acht|zehn|vierzehn)\s*(?:tag|tage|tagen)\s*(?:vorher|davor|vor\s+der|vor\s+dem)/i;
const WOCHE_VORHER = /(?:eine\s+)?woche\s*(?:vorher|davor)/i;
const FESTES_DATUM = /\bam\s+(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})/i;

const ZAHLWORT: Record<string, number> = {
  ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4,
  fünf: 5, fuenf: 5, sieben: 7, acht: 8, zehn: 10, vierzehn: 14,
};

export function isReminderRequest(text: string): boolean {
  return ERINNERUNG.test(text ?? '');
}

/**
 * 01K-F1 — sieht dieser Text aus wie eine Antwort auf die Fristrückfrage?
 *
 * Eine Antwort ist kurz und fragt nichts. „30.09.2026", „die Leistungsfrist",
 * „ja", „später" — alles Antworten, auch die unbrauchbaren; die entscheidet
 * danach `resolveMeantDeadline`, und die unbrauchbaren führen wieder zur
 * Rückfrage. Was dagegen lang ist oder ein Fragezeichen trägt, ist eine neue
 * Frage, und die darf die offene Rückfrage nicht schlucken — sonst sässe der
 * Benutzer in einem Dialog fest, aus dem nur noch ein Datum herausführt.
 */
export function looksLikeReminderAnswer(text: string): boolean {
  const kurz = (text ?? '').trim();
  return kurz.length > 0 && kurz.length <= 60 && !kurz.includes('?');
}

/**
 * Der gewünschte Zeitpunkt. Ohne nähere Angabe erinnert OfficeTakt am Tag der
 * Frist selbst — die nächstliegende Lesart von „erinnere mich daran".
 */
export function parseReminderTiming(text: string): ReminderTiming {
  const eingabe = text ?? '';

  const festes = FESTES_DATUM.exec(eingabe);
  if (festes) {
    const jahr = festes[3].length === 2 ? `20${festes[3]}` : festes[3];
    const iso = `${jahr}-${festes[2].padStart(2, '0')}-${festes[1].padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(iso))) return { kind: 'fixed_date', date: iso };
  }

  const tage = TAGE_VORHER.exec(eingabe);
  if (tage) {
    const roh = tage[1].toLowerCase();
    const anzahl = Number.isNaN(Number(roh)) ? ZAHLWORT[roh] : Number(roh);
    if (anzahl && anzahl > 0) return { kind: 'days_before', days: anzahl };
  }

  if (WOCHE_VORHER.test(eingabe)) return { kind: 'days_before', days: 7 };

  return { kind: 'on_deadline' };
}

/* ------------------------------------------------------------------ */
/* Welche Frist ist gemeint?                                           */
/* ------------------------------------------------------------------ */

/** Wortfelder, mit denen ein Benutzer eine bestimmte Frist benennt. */
const FRIST_HINWEISE: Array<{ muster: RegExp; passt: (frist: SemanticDeadline) => boolean }> = [
  { muster: /(termin|begehung|bestätig|bestaetig|antwort|rückmeld|rueckmeld)/i, passt: (f) => f.type === 'response_due' },
  { muster: /(mangel|mängel|maengel|beseitig|nachbesser|leistung|ausführ|ausfuehr)/i, passt: (f) => f.type === 'service_due' },
  { muster: /(zahlung|bezahlen|überweis|ueberweis)/i, passt: (f) => f.type === 'payment_due' },
  { muster: /(unterlagen|einreich|vorlegen|nachweis)/i, passt: (f) => f.type === 'document_submission_due' },
  { muster: /(kündig|kuendig)/i, passt: (f) => f.type === 'termination_notice' },
];

/**
 * Sucht die gemeinte Frist.
 *
 * Gibt es nur eine Handlungsfrist, ist sie es. Nennt der Benutzer die Sache
 * beim Namen („erinnere mich an die Terminbestätigung"), entscheidet das.
 * Bleiben mehrere übrig, wird **nicht geraten** — dann muss gefragt werden.
 */
export function resolveMeantDeadline(
  text: string,
  core: DocumentSemanticCore | undefined,
): { deadline: SemanticDeadline } | ReminderNeedsChoice | null {
  const handlungsfristen = (core?.deadlines ?? []).filter((f) => f.actionRequired);
  if (handlungsfristen.length === 0) return null;
  if (handlungsfristen.length === 1) return { deadline: handlungsfristen[0] };

  for (const hinweis of FRIST_HINWEISE) {
    if (!hinweis.muster.test(text ?? '')) continue;
    const treffer = handlungsfristen.filter(hinweis.passt);
    if (treffer.length === 1) return { deadline: treffer[0] };
  }

  /*
   * GESAMTABNAHME-01J — das Datum aus der Rückfrage zählt als Antwort.
   *
   * Die Rückfrage zeigt dem Benutzer die Fristen mit Datum: „Antwort:
   * 22.09.2026, Leistung: 30.09.2026". In der Abnahme antwortete ich darauf
   * wie jeder Mensch — mit genau diesem Datum — und bekam wieder dieselbe
   * Rückfrage. Eine Frage zu stellen und die eigene Antwort darauf nicht zu
   * verstehen, ist schlimmer als gar nicht zu fragen.
   *
   * Steht in der Antwort genau **eine** der angebotenen Fristen, ist sie
   * gemeint. Stehen mehrere darin, wird weiterhin nicht geraten.
   */
  const genannt = handlungsfristen.filter((frist) => nenntDatum(text ?? '', frist.date));
  if (genannt.length === 1) return { deadline: genannt[0] };

  return {
    kind: 'needs_choice',
    options: [...handlungsfristen].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/* ------------------------------------------------------------------ */
/* Datum und Vorschlag                                                 */
/* ------------------------------------------------------------------ */

/**
 * Nennt der Text dieses Datum — in der Schreibweise, in der es angeboten wurde?
 *
 * Beide Formen zählen: der ISO-Tag und die deutsche Schreibweise, und diese
 * auch ohne führende Nullen, weil „22.9.2026" genauso gemeint ist.
 */
function nenntDatum(text: string, iso: string): boolean {
  const teile = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!teile) return false;
  const [, jahr, monat, tag] = teile;
  const kurz = `${Number(tag)}.${Number(monat)}.${jahr}`;
  return text.includes(iso) || text.includes(`${tag}.${monat}.${jahr}`) || text.includes(kurz);
}

function minusTage(iso: string, tage: number): string {
  const datum = new Date(`${iso}T00:00:00.000Z`);
  datum.setUTCDate(datum.getUTCDate() - tage);
  return datum.toISOString().slice(0, 10);
}

export function resolveRemindDate(deadline: SemanticDeadline, timing: ReminderTiming): string {
  if (timing.kind === 'fixed_date') return timing.date;
  if (timing.kind === 'days_before') return minusTage(deadline.date, timing.days);
  return deadline.date;
}

function deutsch(iso: string): string {
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return t ? `${t[3]}.${t[2]}.${t[1]}` : iso;
}

/** Worum es geht — aus der Frist selbst, nicht aus einer Dokumentart. */
function sache(deadline: SemanticDeadline): string {
  switch (deadline.type) {
    case 'response_due':
      return 'Antwort';
    case 'service_due':
      return 'Leistung';
    case 'payment_due':
      return 'Zahlung';
    case 'document_submission_due':
      return 'Unterlagen einreichen';
    case 'termination_notice':
      return 'Kündigungsfrist';
    default:
      return 'Termin';
  }
}

/**
 * Baut den Vorschlag. Legt **nichts** an und verändert nichts — auch nicht die
 * Zuordnung: Ein unbestätigter Kunden- oder Auftragskandidat wird hier nicht
 * zur Verknüpfung befördert. Nur eine bereits bestätigte Verknüpfung reist mit.
 */
export function buildReminderProposal(input: {
  text: string;
  item: InboxItem;
  core?: DocumentSemanticCore;
  /**
   * 01K-F1 — der ursprüngliche Wunsch, wenn dieser Text eine **Antwort** auf
   * die Rückfrage „welche Frist?" ist.
   *
   * Der Fall aus der Abnahme: „Erinnere mich zwei Tage vorher." → Rückfrage →
   * „30.09.2026". Der zweite Text ist kein Wiedervorlagewunsch, er ist die
   * Antwort auf unsere Frage. Ohne diesen Zusammenhang fiel er als gewöhnliche
   * Dokumentfrage an das Modell, das dann artig das Datum erklärte. Mit ihm
   * bestimmt die Antwort die Frist, und der Vorlauf („zwei Tage") kommt
   * weiterhin aus dem ursprünglichen Wunsch — nicht aus einer Voreinstellung.
   */
  pendingRequest?: string;
}): ReminderProposalResult {
  const istWunsch = isReminderRequest(input.text);
  if (!istWunsch && !input.pendingRequest) return { kind: 'not_a_reminder' };

  const gemeint = resolveMeantDeadline(input.text, input.core);
  if (!gemeint) return { kind: 'no_deadline' };
  if ('kind' in gemeint) return gemeint;

  const deadline = gemeint.deadline;
  const timing = parseReminderTiming(istWunsch ? input.text : (input.pendingRequest ?? input.text));
  const remindOn = resolveRemindDate(deadline, timing);

  const betreff = input.core?.subject?.value?.trim();
  const titel = `${sache(deadline)}${betreff ? ` – ${betreff}` : ''} – Frist ${deutsch(deadline.date)}`;

  /*
   * Nur eine bestätigte Auftragsverknüpfung wird übernommen. Ein Kandidat
   * bleibt ein Kandidat; ihn hier einzutragen hiesse, eine Vermutung durch die
   * Hintertür zu bestätigen.
   */
  const bestaetigterVorgang =
    input.item.vorgangId && input.item.vorgangLinkStatus === 'linked'
      ? getVorgangById(input.item.vorgangId)
      : undefined;

  const dedupeKey = `reminder:${input.item.id}:${deadline.type}:${deadline.date}:${remindOn}`;

  const proposal: TaskProposal = {
    title: titel,
    description: `Erinnerung am ${deutsch(remindOn)}. Frist im Schreiben: ${deutsch(deadline.date)} (${deadline.appliesTo}).`,
    priority: 'mittel',
    category: 'dokumente',
    dueDate: remindOn,
    linkedInboxId: input.item.id,
    linkedDocumentId: input.item.archiveDocumentId,
    linkedVorgangId: bestaetigterVorgang?.id,
    linkedVorgangTitle: bestaetigterVorgang?.title,
    sourceType: 'manual',
    sourceId: input.item.id,
    taskKind: 'document_reminder',
    dedupeKey,
    autoCreated: false,
    type: 'dokument_pruefen',
  };

  return {
    kind: 'proposal',
    value: {
      proposal,
      remindOn,
      deadline,
      alreadyExists: Boolean(findExistingOpenTaskByDedupeKey(dedupeKey)),
    },
  };
}

export type ConfirmReminderResult =
  | { ok: true; task: Task; created: boolean }
  | { ok: false; reason: 'already_exists' };

/**
 * Legt die Wiedervorlage an — **nur** auf ausdrückliche Bestätigung.
 *
 * Der Dedupe kommt aus `createTaskFromProposal`: Liegt bereits eine offene
 * Aufgabe mit demselben Schlüssel vor, gibt es sie zurück, statt eine zweite
 * anzulegen. Zweimal bestätigen erzeugt also keine zweite Aufgabe.
 */
export function confirmReminderProposal(proposal: TaskProposal): ConfirmReminderResult {
  const bestand = proposal.dedupeKey ? findExistingOpenTaskByDedupeKey(proposal.dedupeKey) : null;
  const task = createTaskFromProposal(proposal);
  return { ok: true, task, created: !bestand };
}
