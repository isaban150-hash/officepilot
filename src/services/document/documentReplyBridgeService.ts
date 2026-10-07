/**
 * DOKUMENT-ASSISTENT-01G — von der Anweisung im Gespräch zum Entwurf.
 *
 * Der Ist-Zustand vor diesem Block war lehrreich: Auf „Schreib denen, dass wir
 * am 25.09. kommen" antwortete OfficeTakt mit **„KI-Antwort verworfen — Neue
 * Datumsangabe nicht erlaubt: 25.09.2026"**. Und das war richtig: Die
 * Frage-Kette darf keine Angabe erzeugen, die nicht im Dokument steht.
 *
 * Ein Entwurf ist aber etwas anderes als eine Auskunft. Dort **soll** die
 * Angabe des Benutzers hinein — sie ist seine eigene Zusage, nicht eine
 * Behauptung über das Dokument. Deshalb läuft dieser Weg nicht über die
 * Frage-Kette, sondern über den vorhandenen Entwurfsweg
 * (`buildCommunicationDraft` mit `document_reply`), der genau dafür gebaut ist
 * und ohne Sprachmodell auskommt.
 *
 * Gebaut wird hier **nur die fehlende Verbindung**: kein zweiter Editor, kein
 * zweiter Briefweg, kein zweiter Versandweg. Der Entwurf wird an den
 * vorhandenen Briefeditor oder an den vorhandenen Kommunikationsweg übergeben,
 * und dort entscheidet der Benutzer.
 */
import type { ClassifiedDocumentKind, CompanyDocument, CompanyProfile, Customer, InboxItem } from '../../types/models';
import type { CommunicationContext, CommunicationDraftCore } from '../../types/communication';
import type { DocumentReplySourceRef } from '../../types/documentReply';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { buildCommunicationDraft } from '../communicationDraftService';
import { getVorgangById, isInboxLinkedToVorgang } from '../vorgangService';
import { getCustomerById } from '../customerStoreService';
import { getCompanyProfile } from '../companyProfileService';
import { normalizeCompanyIdentityValue } from '../companyRelevanceService';
import { isAuthorityClassifiedKind, isInsuranceClassifiedKind } from '../businessInterpretationMeaning';

/** Welcher Weg nach dem Entwurf naheliegt. */
export type ReplyChannelPreference = 'letter' | 'email' | 'undecided';

const ANTWORT_WUNSCH =
  /(schreib(e)?\s|antworte|antwort\s+(verfassen|formulieren|vorbereiten)|formuliere|verfasse|entwirf|aufsetzen|teile\s+(ihnen|denen)\s+mit|sag\s+(ihnen|denen))/i;

/* „Erinnere mich" gehört zu 01F und darf hier nicht abgefangen werden. */
const WIEDERVORLAGE = /(erinnere?\s+mich|erinnerung|wiedervorlage)/i;

const BRIEF_WUNSCH = /\b(brief|postalisch|per\s+post|anschreiben)\b/i;
const MAIL_WUNSCH = /\b(e-?mail|mail|mailen)\b/i;

/**
 * Will der Benutzer eine Antwort — oder stellt er eine Frage?
 *
 * Absichtlich eng: „Was muss ich tun?" und „Bis wann?" bleiben gewöhnliche
 * Fragen. Nur eine Aufforderung zu schreiben löst den Entwurfsweg aus.
 */
export function isReplyRequest(text: string): boolean {
  const eingabe = text ?? '';
  if (WIEDERVORLAGE.test(eingabe)) return false;
  return ANTWORT_WUNSCH.test(eingabe);
}

/**
 * Der Kanal, falls der Benutzer ihn schon genannt hat. Eine Vorauswahl ist
 * keine Ausführung — gewählt wird danach trotzdem ausdrücklich.
 */
export function detectChannelPreference(text: string): ReplyChannelPreference {
  const eingabe = text ?? '';
  const brief = BRIEF_WUNSCH.test(eingabe);
  const mail = MAIL_WUNSCH.test(eingabe);
  if (brief && !mail) return 'letter';
  if (mail && !brief) return 'email';
  return 'undecided';
}

/**
 * Die Kernaussage — das, was der Benutzer gesagt haben will.
 *
 * Der Einleitungsteil („Schreib denen, dass …") wird abgetrennt; der Rest ist
 * seine Aussage und wandert unverändert in den Entwurf. Nichts wird ergänzt.
 */
export function extractCoreMessage(text: string): string {
  let rest = (text ?? '').trim();

  /* Die Anweisung selbst („Schreib denen eine E-Mail und …") fällt weg. */
  rest = rest.replace(
    /^(bitte\s+)?(schreib(e)?|antworte|formuliere|verfasse|entwirf|sag)\s*(mir|uns|denen|ihnen|dem\s+\w+|der\s+\w+)?\s*(eine|einen|ein)?\s*(e-?mail|mail|brief|antwort|nachricht|anschreiben)?\s*(und|,)?\s*/i,
    '',
  );

  /*
   * Eine Bitte bleibt eine Bitte: „frag nach drei Raten" wird zu „Wir bitten
   * um drei Raten." Das ist dieselbe Aussage in der Sprache eines Schreibens —
   * es kommt nichts hinzu.
   */
  const bitte = /^(frag(e|en)?\s+(nach|um)|bitte\s+um|erkundige\s+dich\s+nach)\s+(.+)$/i.exec(rest);
  if (bitte) {
    return satzEnde(`Wir bitten um ${bitte[4].trim()}`);
  }

  /*
   * „dass wir am 25.09. kommen" ist ein Nebensatz. Ohne Hauptsatz stand im
   * Brief „wir am 25.09. kommen." — grammatisch zerbrochen. Der Nebensatz
   * bekommt deshalb seinen Hauptsatz; die Aussage selbst bleibt unverändert.
   */
  const nebensatz = /^(dass|das)\s+(.+)$/i.exec(rest);
  if (nebensatz) {
    return satzEnde(`Wir teilen Ihnen mit, dass ${nebensatz[2].trim()}`);
  }

  return satzEnde(rest.trim());
}

/**
 * Ein Satz endet mit einem Satzzeichen; mehr wird nicht verändert.
 *
 * Bleibt nach dem Abtrennen der Anweisung nur noch ein Satzzeichen übrig
 * („Schreib."), ist das keine Aussage — dann entsteht auch kein Entwurf.
 */
function satzEnde(text: string): string {
  const sauber = text.trim();
  if (!/[a-zäöüß]/i.test(sauber)) return '';
  return /[.!?]$/.test(sauber) ? sauber : `${sauber}.`;
}

/* ------------------------------------------------------------------ */
/* Empfänger                                                           */
/* ------------------------------------------------------------------ */

export interface ReplyRecipient {
  name: string;
  organization?: string;
  street?: string;
  zip?: string;
  city?: string;
  email?: string;
  /** Woher die Angaben stammen — für die ehrliche Anzeige. */
  source: 'confirmed_customer' | 'document' | 'unknown';
  /** Bestätigter Kundenstamm; nur dann darf eine Kennung mitreisen. */
  customerId?: string;
}

/**
 * P1 EINGANGSSCHREIBEN — der bestätigte Vorgangsbezug des Eingangs: verknüpft
 * (`linked`) **oder** aus dem Dokument heraus angelegt (`created`). Dieselbe
 * Regel, die `isInboxLinkedToVorgang` überall sonst anwendet; vorher fiel ein
 * angelegter Vorgang hier auf den Absendernamen zurück.
 */
function confirmedVorgangOfInbox(item: InboxItem) {
  return isInboxLinkedToVorgang(item) && item.vorgangId ? getVorgangById(item.vorgangId) : undefined;
}

function recipientFromCustomer(kunde: Customer): ReplyRecipient {
  return {
    name: kunde.contactPerson?.trim() || kunde.name,
    organization: kunde.name,
    street: kunde.street ?? undefined,
    zip: kunde.zip ?? undefined,
    city: kunde.city ?? undefined,
    email: kunde.email ?? undefined,
    source: 'confirmed_customer',
    customerId: kunde.id,
  };
}

/** Rechtsformzusätze tragen keine Identität — „GmbH" allein ist niemand. */
const LEGAL_FORM_WORDS = new Set(['gmbh', 'mbh', 'ug', 'ag', 'kg', 'ohg', 'gbr', 'co', 'e', 'k', 'ek', 'kgaa', 'se', 'haftungsbeschrankt']);

function nameWords(value: string): string[] {
  return normalizeCompanyIdentityValue(value)
    .split(' ')
    .filter((word) => word && !LEGAL_FORM_WORDS.has(word));
}

/** Alle Wörter des einen Namens stehen im anderen — und eines davon trägt. */
function coversName(words: string[], other: string[]): boolean {
  return words.some((word) => word.length >= 4) && words.every((word) => other.includes(word));
}

/**
 * P1 EINGANGSSCHREIBEN — ein belegter Name, der die eigene Firma ist, ist kein
 * Antwortempfänger. Die Erkennung kürzt den eigenen Namen mitunter
 * („Haustechnik GmbH" statt „Çırmak Haustechnik GmbH"); deshalb zählt hier
 * auch ein Name, dessen Wörter vollständig im eigenen Namen stehen — oder
 * umgekehrt. Im Zweifel bleibt der Empfänger offen: Ein offener Empfänger wird
 * im Entwurf ergänzt, eine Antwort an die eigene Firma wäre falsch.
 */
function externalPartyName(candidate: string | undefined | null): string {
  const name = candidate?.trim() ?? '';
  return name && !sameParty(name, getCompanyProfile().companyName ?? '') ? name : '';
}

/** Zwei Namen bezeichnen denselben Beteiligten: gleich nach der Faltung, oder einer deckt den anderen. */
function sameParty(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return false;
  return x.join(' ') === y.join(' ') || coversName(x, y) || coversName(y, x);
}

/**
 * P1 EINGANGSSCHREIBEN — der Kunde des bestätigten Vorgangs ist Empfänger, wenn
 * das Schreiben von ihm kommt: Der belegte Absender ist der Kunde oder sein
 * Ansprechpartner — oder es ist keiner belegt. Schreibt ein Dritter (das Bauamt
 * zum Bauvorhaben des Kunden), geht die Antwort an diesen Absender; der Vorgang
 * bleibt der Bezug. Behörden- und Versicherungsschreiben kommen nie vom Kunden.
 */
function replyGoesToCustomer(
  kunde: Customer,
  absender: string,
  kind: ClassifiedDocumentKind | undefined,
): boolean {
  if (kind && (isAuthorityClassifiedKind(kind) || isInsuranceClassifiedKind(kind))) return false;
  if (!absender) return true;
  return [kunde.name, kunde.contactPerson ?? ''].some((name) => sameParty(absender, name));
}

function recipientFor(
  kunde: Customer | undefined,
  belegterAbsender: string | undefined,
  kind: ClassifiedDocumentKind | undefined,
): ReplyRecipient {
  const absender = externalPartyName(belegterAbsender);
  if (kunde && replyGoesToCustomer(kunde, absender, kind)) return recipientFromCustomer(kunde);
  /* Nur der Name ist belegt. Eine Anschrift wird nicht erfunden. */
  if (absender) return { name: absender, organization: absender, source: 'document' };
  return { name: '', source: 'unknown' };
}

/**
 * Wer angeschrieben wird.
 *
 * Rangfolge: ein **bestätigt** zugeordneter Kunde (wenn das Schreiben von ihm
 * kommt, siehe `replyGoesToCustomer`), dann der im Schreiben belegte Absender,
 * sonst nichts. Ein unbestätigter Kandidat wird hier
 * ausdrücklich **nicht** zum Kunden befördert — das wäre eine stille
 * Bestätigung durch die Hintertür.
 *
 * P1 EINGANGSSCHREIBEN — der semantische Kern liefert keinen Absender:
 * `recipientCheck.matchedOn` sagt, woran die **eigene** Firma im Schreiben
 * erkannt wurde, und wird deshalb nie zum Empfänger.
 */
export function resolveReplyRecipient(
  item: InboxItem,
  _core?: DocumentSemanticCore,
): ReplyRecipient {
  const vorgang = confirmedVorgangOfInbox(item);
  const kunde = vorgang?.customerId ? getCustomerById(vorgang.customerId) : undefined;
  return recipientFor(kunde, item.sender, item.classifiedKind);
}

/**
 * P1 EINGANGSSCHREIBEN — dieselbe Rangfolge für ein archiviertes Schreiben:
 * der Kunde des verknüpften Vorgangs (Dokument → Vorgang → Kunde), wenn das
 * Schreiben von ihm kommt, sonst der belegte Aussteller ohne erfundene Anschrift.
 */
export function resolveReplyRecipientForDocument(document: CompanyDocument): ReplyRecipient {
  const vorgangId = document.linkedVorgang?.vorgangId;
  const vorgang = vorgangId ? getVorgangById(vorgangId) : undefined;
  const kunde = vorgang?.customerId ? getCustomerById(vorgang.customerId) : undefined;
  return recipientFor(kunde, document.issuer, document.classifiedKind);
}

export function hasPostalAddress(recipient: ReplyRecipient): boolean {
  return Boolean(recipient.street?.trim() && recipient.zip?.trim() && recipient.city?.trim());
}

export function hasEmailAddress(recipient: ReplyRecipient): boolean {
  return Boolean(recipient.email?.trim());
}

/* ------------------------------------------------------------------ */
/* Entwurf                                                             */
/* ------------------------------------------------------------------ */

export interface ReplyDraftResult {
  draft: CommunicationDraftCore;
  recipient: ReplyRecipient;
  channelPreference: ReplyChannelPreference;
  /** Der bestätigte Auftrag, falls es einen gibt — sonst nichts. */
  confirmedVorgangId?: string;
  /** P1 EINGANGSSCHREIBEN — das Schreiben, auf das geantwortet wird. */
  sourceRef: DocumentReplySourceRef;
}

/**
 * Baut den Entwurf über den vorhandenen Weg.
 *
 * Die belegten Dokumentangaben reisen als `facts` mit, damit der Entwurf
 * erkennen lässt, worauf geantwortet wird. Der Volltext bleibt draussen — eine
 * OCR-Kopie im Antwortschreiben hülfe niemandem.
 */
export function buildReplyDraft(input: {
  text: string;
  item: InboxItem;
  core?: DocumentSemanticCore;
  companyProfile: CompanyProfile | null;
}): ReplyDraftResult | null {
  const kern = extractCoreMessage(input.text);
  if (!kern) return null;

  const recipient = resolveReplyRecipient(input.item, input.core);
  const vorgang = confirmedVorgangOfInbox(input.item);
  const absender = externalPartyName(input.item.sender);

  const facts = [
    input.core?.subject
      ? { key: 'Betreff des Schreibens', value: input.core.subject.value, source: 'document' as const }
      : null,
    absender
      ? { key: 'Absender', value: absender, source: 'document' as const }
      : null,
    ...(input.core?.deadlines ?? [])
      .filter((frist) => frist.actionRequired)
      .map((frist) => ({
        key: `Frist (${frist.appliesTo})`,
        value: frist.date,
        source: 'document' as const,
      })),
    { key: 'Kernaussage', value: kern, source: 'user' as const },
  ].filter(Boolean) as CommunicationContext['facts'];

  const context: CommunicationContext = {
    ref: { type: 'inbox', id: input.item.id, ...(vorgang ? { vorgangId: vorgang.id } : {}) },
    companyName: input.companyProfile?.companyName ?? '',
    recipient: { name: recipient.name, organization: recipient.organization },
    subject: input.core?.subject?.value ?? input.item.title,
    facts,
    relevanceAllowed: true,
    disclaimer: '',
    ...(vorgang
      ? {
          vorgangSummary: {
            id: vorgang.id,
            title: vorgang.title,
            customer: vorgang.customer,
            baustelle: vorgang.baustelle,
          },
        }
      : {}),
  };

  /*
   * `userAnswers` ist der Weg, auf dem eine bereits aufbereitete Angabe in den
   * Entwurf gelangt. Ohne sie greift der Dienst auf `userText` zurück — also
   * auf den rohen Befehlssatz, und im Brief stand dann „wir am 25.09. kommen."
   */
  const draft = buildCommunicationDraft(
    { userText: kern, userAnswers: { coreMessage: kern } },
    context,
    'document_reply',
  );
  if (!draft) return null;

  return {
    draft,
    recipient,
    channelPreference: detectChannelPreference(input.text),
    confirmedVorgangId: vorgang?.id,
    sourceRef: { type: 'inbox', id: input.item.id },
  };
}

/* ------------------------------------------------------------------ */
/* Übergabe an den Briefeditor                                         */
/* ------------------------------------------------------------------ */

/**
 * Was der Briefeditor braucht, um den Entwurf zu übernehmen.
 *
 * Bewusst kein `BusinessLetterInput`: Der Editor legt den Brief selbst an,
 * sobald der Benutzer speichert. Hier reist nur die **Vorbelegung** — nichts
 * wird gespeichert, nichts fertiggestellt, kein PDF, kein Archiv.
 */
export interface LetterDraftPrefill {
  subject: string;
  body: string;
  recipient: {
    name: string;
    company?: string;
    street?: string;
    zip?: string;
    city?: string;
  };
  /** Nur bei bestätigter Zuordnung gesetzt. */
  customerId?: string;
  vorgangId?: string;
  /**
   * P1 EINGANGSSCHREIBEN — das Schreiben, auf das der Brief antwortet. Reine
   * Herkunft; der Antwortstatus bleibt im Kommunikationsverlauf.
   */
  replyTo?: DocumentReplySourceRef;
}

export const LETTER_DRAFT_PREFILL_STATE_KEY = 'officetaktLetterDraftPrefill';

export function buildLetterPrefill(result: ReplyDraftResult): LetterDraftPrefill {
  return {
    subject: result.draft.subject ?? '',
    body: result.draft.body,
    recipient: {
      name: result.recipient.name,
      company: result.recipient.organization,
      street: result.recipient.street,
      zip: result.recipient.zip,
      city: result.recipient.city,
    },
    /* Nur eine bestätigte Zuordnung reist mit. Ein Kandidat bleibt Kandidat. */
    ...(result.recipient.source === 'confirmed_customer' && result.recipient.customerId
      ? { customerId: result.recipient.customerId }
      : {}),
    ...(result.confirmedVorgangId ? { vorgangId: result.confirmedVorgangId } : {}),
    replyTo: { type: result.sourceRef.type, id: result.sourceRef.id },
  };
}

export function isLetterDraftPrefill(value: unknown): value is LetterDraftPrefill {
  if (!value || typeof value !== 'object') return false;
  const kandidat = value as Partial<LetterDraftPrefill>;
  return typeof kandidat.subject === 'string' && typeof kandidat.body === 'string';
}
