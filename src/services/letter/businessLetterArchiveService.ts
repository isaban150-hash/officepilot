/**
 * BRIEFE-01D — die Ablage eines fertiggestellten Geschäftsschreibens im
 * bestehenden Dokumentenarchiv.
 *
 * Kein zweiter Dokumentenstapel: Das Schreiben bekommt einen ganz gewöhnlichen
 * Eintrag im Firmenarchiv, mit der eigenen Kategorie „Geschäftsschreiben", und
 * reist über denselben Cloud-Weg wie jedes andere abgelegte Dokument.
 *
 * Die Verknüpfung ist bewusst zweiseitig:
 *   Brief → Dokument über `BusinessLetter.documentId` (die führende Wahrheit;
 *           sie wird ohnehin synchronisiert und der Server-Guard lässt sie an
 *           einem fertiggestellten Brief ausdrücklich zu),
 *   Dokument → Brief über `CompanyDocument.linkedLetterId` (der Rückweg, damit
 *           das Archiv nicht alle Briefe durchsuchen muss).
 *
 * **Entwürfe werden nicht abgelegt.** Erst die Fertigstellung macht aus einem
 * Text einen Beleg.
 */
import { addDocument, getDocumentById, getDocumentByLinkedLetterId } from '../documentService';
import { attachArchiveDocumentToLetter, getBusinessLetterById } from '../businessLetterService';
import { getVorgangById } from '../vorgangService';
import { PAPER_FOLDERS } from '../../data/mockData';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CompanyDocument, PaperFilingRule } from '../../types/models';

export type BusinessLetterArchiveResult =
  | { ok: true; document: CompanyDocument; created: boolean }
  | { ok: false; reason: 'not_finalized' | 'archive_failed' };

/**
 * Liefert die Archivablage des Briefes und legt sie an, falls sie fehlt.
 *
 * Die Idempotenz steht auf zwei Beinen, damit ein Doppeleintrag auch dann nicht
 * entsteht, wenn eine der beiden Seiten unvollständig ist:
 *   1. trägt der Brief schon eine `documentId` und existiert dieses Dokument,
 *      wird es zurückgegeben — ohne etwas anzulegen;
 *   2. findet sich ein Dokument mit passender `linkedLetterId`, wird nur die
 *      fehlende Verknüpfung am Brief nachgezogen.
 * Erst wenn beides ins Leere läuft, entsteht ein neuer Eintrag.
 */
export function ensureBusinessLetterArchived(letter: BusinessLetter): BusinessLetterArchiveResult {
  if (letter.status !== 'finalized') return { ok: false, reason: 'not_finalized' };

  /* 1 — der Brief weiss bereits, wo er liegt. */
  const bekannt = letter.documentId?.trim();
  if (bekannt) {
    const vorhanden = getDocumentById(bekannt);
    if (vorhanden) return { ok: true, document: vorhanden, created: false };
  }

  /* 2 — die Ablage gibt es, nur der Rückverweis am Brief fehlt. */
  const ueberRueckweg = getDocumentByLinkedLetterId(letter.id);
  if (ueberRueckweg) {
    attachArchiveDocumentToLetter(letter.id, ueberRueckweg.id);
    return { ok: true, document: ueberRueckweg, created: false };
  }

  /* 3 — noch nichts vorhanden: anlegen. */
  const ergebnis = addDocument({
    title: letter.subject.trim(),
    category: 'geschaeftsschreiben',
    issuer: absenderName(letter),
    issueDate: letter.letterDate || null,
    documentDate: letter.letterDate || null,
    linkedCompany: empfaengerName(letter),
    linkedVorgang: vorgangVerknuepfung(letter),
    linkedLetterId: letter.id,
    /*
     * Festgehalten, nicht geraten: OfficePilot hat dieses Schreiben selbst
     * verfasst und weiss, was es ist. Ohne die Angabe würden Verständnis und
     * Ablage aus Absender und Text raten — beim ersten Versuch landete der
     * Brief so im Register „Finanzamt".
     */
    classifiedKind: 'schriftverkehr',
    digitalFolder: {
      id: `dig-letter-${letter.id}`,
      name: 'Geschäftsschreiben',
      path: '/Geschäftsschreiben/',
    },
    paperFolder: eigenerPapierordner(),
    archived: true,
    /*
     * Der Brieftext als durchsuchbarer Inhalt. Das Archiv sucht über Titel,
     * Aussteller und erkannten Text; ohne ihn wäre ein Schreiben nur über
     * seinen Betreff auffindbar.
     */
    recognizedText: `${letter.subject.trim()}\n\n${letter.body.trim()}`,
    tags: ['Geschäftsschreiben'],
  });

  if (!ergebnis.success) return { ok: false, reason: 'archive_failed' };

  const verknuepft = attachArchiveDocumentToLetter(letter.id, ergebnis.document.id);
  if (!verknuepft.success) return { ok: false, reason: 'archive_failed' };

  return { ok: true, document: ergebnis.document, created: true };
}

/**
 * Der Rückweg für das Archiv: zu welchem Geschäftsschreiben gehört dieses
 * Dokument? Die `linkedLetterId` ist der direkte Schlüssel.
 */
export function getBusinessLetterForDocument(document: CompanyDocument): BusinessLetter | undefined {
  const id = document.linkedLetterId?.trim();
  if (!id) return undefined;
  return getBusinessLetterById(id) ?? undefined;
}

/** Erkennt ein selbst verfasstes Geschäftsschreiben im Archiv. */
export function isBusinessLetterDocument(document: CompanyDocument): boolean {
  return document.category === 'geschaeftsschreiben' && Boolean(document.linkedLetterId?.trim());
}

/**
 * Der Ablageort, falls der Betrieb seine eigene Durchschrift doch abheften
 * will. Er wird gespeichert, aber nicht als Aufforderung angezeigt: Zu einem
 * selbst verfassten Schreiben gibt es kein fremdes Original, das eingeheftet
 * werden müsste.
 */
function eigenerPapierordner(): PaperFilingRule {
  const ordner = PAPER_FOLDERS.find((item) => item.id === 'paper-kunden') ?? PAPER_FOLDERS[0];
  return {
    folderId: ordner.id,
    register: ordner.registers.includes('Sonstiges') ? 'Sonstiges' : (ordner.registers[0] ?? 'A'),
    label: ordner.name,
  };
}

function absenderName(letter: BusinessLetter): string {
  const profil = letter.companySnapshot;
  return profil?.companyName?.trim() ?? '';
}

function empfaengerName(letter: BusinessLetter): string {
  const e = letter.recipient;
  return e.company?.trim() || e.name?.trim() || '';
}

function vorgangVerknuepfung(letter: BusinessLetter) {
  const id = letter.vorgangId?.trim();
  if (!id) return null;
  const vorgang = getVorgangById(id);
  if (!vorgang) return null;
  return { vorgangId: vorgang.id, vorgangTitle: vorgang.title };
}
