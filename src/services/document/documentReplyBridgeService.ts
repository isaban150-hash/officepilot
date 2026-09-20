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
import type { CompanyProfile, InboxItem } from '../../types/models';
import type { CommunicationContext, CommunicationDraftCore } from '../../types/communication';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import { buildCommunicationDraft } from '../communicationDraftService';
import { getVorgangById } from '../vorgangService';
import { getCustomerById } from '../customerStoreService';

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
 * Wer angeschrieben wird.
 *
 * Rangfolge: ein **bestätigt** zugeordneter Kunde, dann der im Schreiben
 * belegte Absender, sonst nichts. Ein unbestätigter Kandidat wird hier
 * ausdrücklich **nicht** zum Kunden befördert — das wäre eine stille
 * Bestätigung durch die Hintertür.
 */
export function resolveReplyRecipient(
  item: InboxItem,
  core: DocumentSemanticCore | undefined,
): ReplyRecipient {
  const vorgang =
    item.vorgangId && item.vorgangLinkStatus === 'linked' ? getVorgangById(item.vorgangId) : undefined;
  const kunde = vorgang?.customerId ? getCustomerById(vorgang.customerId) : undefined;

  if (kunde) {
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

  const absender = item.sender?.trim() || core?.recipientCheck.matchedOn[0];
  if (absender) {
    /* Nur der Name ist belegt. Eine Anschrift wird nicht erfunden. */
    return { name: absender, organization: absender, source: 'document' };
  }

  return { name: '', source: 'unknown' };
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
  const vorgang =
    input.item.vorgangId && input.item.vorgangLinkStatus === 'linked'
      ? getVorgangById(input.item.vorgangId)
      : undefined;

  const facts = [
    input.core?.subject
      ? { key: 'Betreff des Schreibens', value: input.core.subject.value, source: 'document' as const }
      : null,
    input.item.sender
      ? { key: 'Absender', value: input.item.sender, source: 'document' as const }
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
  };
}

export function isLetterDraftPrefill(value: unknown): value is LetterDraftPrefill {
  if (!value || typeof value !== 'object') return false;
  const kandidat = value as Partial<LetterDraftPrefill>;
  return typeof kandidat.subject === 'string' && typeof kandidat.body === 'string';
}
