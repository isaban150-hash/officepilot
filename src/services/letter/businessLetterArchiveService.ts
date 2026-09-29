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
import { persistAll } from '../persistenceService';
import { persistDerivedArchiveRepresentationBinding } from '../documentFileRepresentationDerivedArchiveBindingPersistenceService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from '../documentFileRepresentationBindingStoreService';
import { getDocumentFileRefById, storeDocumentFileFromCachedPayload } from '../documentFileStoreService';
import { attachArchiveDocumentToLetter, getBusinessLetterById } from '../businessLetterService';
import { getVorgangById } from '../vorgangService';
import { getCustomerById } from '../customerStoreService';
import { generateBusinessLetterPdf } from './businessLetterPdfService';
import { PAPER_FOLDERS } from '../../data/mockData';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CompanyDocument, PaperFilingRule } from '../../types/models';

/**
 * E-MAIL-07B — `pdf` sagt, ob am Archiveintrag das tatsächliche PDF hängt:
 *   `attached` jetzt abgelegt · `existing` war schon da ·
 *   `kept` der Eintrag trägt bereits eine (andere) Datei und wird nicht angetastet ·
 *   `failed` Erzeugen/Ablegen gescheitert — der Eintrag selbst besteht trotzdem.
 */
export type BusinessLetterArchivePdfState = 'attached' | 'existing' | 'kept' | 'failed';

export type BusinessLetterArchiveResult =
  | { ok: true; document: CompanyDocument; created: boolean; pdf: BusinessLetterArchivePdfState }
  | { ok: false; reason: 'not_finalized' | 'archive_failed' };

/** Laufende Ablagen je Brief — ein zweiter gleichzeitiger Aufruf legt keine zweite Datei ab. */
const laufend = new Map<string, Promise<BusinessLetterArchiveResult>>();

/**
 * Liefert die Archivablage des Briefes und legt sie an, falls sie fehlt —
 * E-MAIL-07B: **samt tatsächlichem PDF**, genau wie die Angebotsablage
 * (`ensureOfferArchived`). Bis 07B entstand der Eintrag ohne Datei; das PDF
 * wurde nur zum Ansehen im Speicher erzeugt, und der Versand meldete deshalb
 * „es liegt keine PDF-Datei dazu vor".
 *
 * Die Idempotenz steht auf zwei Beinen, damit ein Doppeleintrag auch dann nicht
 * entsteht, wenn eine der beiden Seiten unvollständig ist:
 *   1. trägt der Brief schon eine `documentId` und existiert dieses Dokument,
 *      wird es zurückgegeben — ohne etwas anzulegen;
 *   2. findet sich ein Dokument mit passender `linkedLetterId`, wird nur die
 *      fehlende Verknüpfung am Brief nachgezogen.
 * Erst wenn beides ins Leere läuft, entsteht ein neuer Eintrag. In allen drei
 * Fällen wird ein fehlendes PDF nachgezogen — auch für Briefe, die vor 07B
 * abgelegt wurden.
 */
export function ensureBusinessLetterArchived(letter: BusinessLetter): Promise<BusinessLetterArchiveResult> {
  const bereits = laufend.get(letter.id);
  if (bereits) return bereits;
  const lauf = ablegen(letter).finally(() => laufend.delete(letter.id));
  laufend.set(letter.id, lauf);
  return lauf;
}

async function ablegen(letter: BusinessLetter): Promise<BusinessLetterArchiveResult> {
  if (letter.status !== 'finalized') return { ok: false, reason: 'not_finalized' };

  const vorhanden = findArchiveEntry(letter);
  if (vorhanden) {
    const mitPdf = await ensureArchivePdfForExistingEntry(letter, vorhanden);
    return { ok: true, document: mitPdf.document, created: false, pdf: mitPdf.pdf };
  }

  /*
   * 07B-FIX2 — neuer Eintrag: PDF zuerst, dann der Eintrag in **einem**
   * Schritt mit `fileRefId` (wie `ensureOfferArchived`). Eine spätere Änderung
   * der Dokumentzeile — die mit einem zwischenzeitlichen Sync konkurrieren
   * könnte — gibt es damit nicht.
   */
  const datei = await storeLetterPdf(letter);
  const angelegt = createArchiveEntry(letter, datei);
  if (!angelegt.ok) return angelegt;
  return { ok: true, document: angelegt.document, created: true, pdf: datei ? 'attached' : 'failed' };
}

interface GespeichertesPdf {
  fileRefId: string;
  contentHash: string;
  fileName: string;
  fileSize: number;
}

async function storeLetterPdf(letter: BusinessLetter): Promise<GespeichertesPdf | null> {
  const pdf = await generateBusinessLetterPdf(letter);
  if (!pdf.ok) return null;
  try {
    const stored = await storeDocumentFileFromCachedPayload({
      fileName: pdf.filename,
      mimeType: 'application/pdf',
      fileSize: pdf.bytes.byteLength,
      bytes: pdf.bytes,
    });
    return { fileRefId: stored.fileRef.id, contentHash: stored.fileRef.contentHash, fileName: pdf.filename, fileSize: pdf.bytes.byteLength };
  } catch {
    return null;
  }
}

function isCommittedPdf(fileRefId: string | undefined): boolean {
  if (!fileRefId) return false;
  const ref = getDocumentFileRefById(fileRefId);
  return ref?.mimeType === 'application/pdf' && ref.lifecycleStatus === 'committed';
}

/**
 * Hängt das PDF an einen **bestehenden** Archiveintrag, falls noch keines dort
 * hängt.
 *
 * 07B-FIX2 — die Dokumentzeile selbst wird dabei **nicht** verändert. Bis
 * 07B-FIX2 setzte die Nachrüstung `fileRefId` per `updateDocument`; das
 * schrieb beim nächsten Sync den ganzen Archiveintrag neu — mit lokal
 * erhöhter Version (Versionskonflikt, blocked) und, wäre die Cloud-Zeile
 * inzwischen neuer gewesen, mit dem Risiko, deren neuere Felder zu
 * überschreiben. Jetzt kommt das PDF als eigene Archiv-Dateibindung hinzu:
 * eine separate Entität mit eigener Version, die Versand und Server ohnehin
 * als PDF des Dokuments anerkennen (`original` oder `archive`). Rein additiv.
 *
 * Nie umgehängt wird eine vorhandene Datei — weder `fileRefId` noch eine
 * bestehende Archiv-Bindung, auch wenn die Datei auf diesem Gerät (noch)
 * fehlt. Eine zweite Ablage desselben Briefes wäre eine Doppelablage.
 */
async function ensureArchivePdfForExistingEntry(
  letter: BusinessLetter,
  document: CompanyDocument,
): Promise<{ document: CompanyDocument; pdf: BusinessLetterArchivePdfState }> {
  const vorhandeneDatei = document.fileRefId?.trim();
  if (vorhandeneDatei) return { document, pdf: isCommittedPdf(vorhandeneDatei) ? 'existing' : 'kept' };

  const archivBindung = getDocumentFileRepresentationBindingStoreSnapshot().find(
    (binding) => binding.documentId === document.id && binding.kind === 'archive',
  );
  if (archivBindung) return { document, pdf: isCommittedPdf(archivBindung.fileRefId) ? 'existing' : 'kept' };

  const datei = await storeLetterPdf(letter);
  if (!datei) return { document, pdf: 'failed' };

  let bindung: ReturnType<typeof persistDerivedArchiveRepresentationBinding>;
  try {
    bindung = persistDerivedArchiveRepresentationBinding({ documentId: document.id, archiveFileRefId: datei.fileRefId });
  } catch {
    return { document, pdf: 'failed' };
  }
  if (bindung.kind === 'conflict') return { document, pdf: 'kept' };
  const gesichert = persistAll();
  if (!gesichert.success) return { document, pdf: 'failed' };
  return { document: getDocumentById(document.id) ?? document, pdf: 'attached' };
}

/** Der vorhandene Archiveintrag des Briefes — über `documentId` oder den Rückverweis. */
function findArchiveEntry(letter: BusinessLetter): CompanyDocument | undefined {
  /* 1 — der Brief weiss bereits, wo er liegt. */
  const bekannt = letter.documentId?.trim();
  if (bekannt) {
    const vorhanden = getDocumentById(bekannt);
    if (vorhanden) return vorhanden;
  }

  /* 2 — die Ablage gibt es, nur der Rückverweis am Brief fehlt. */
  const ueberRueckweg = getDocumentByLinkedLetterId(letter.id);
  if (ueberRueckweg) {
    attachArchiveDocumentToLetter(letter.id, ueberRueckweg.id);
    return ueberRueckweg;
  }
  return undefined;
}

/** 3 — noch nichts vorhanden: anlegen, mit dem PDF, wenn es erzeugt werden konnte. */
function createArchiveEntry(letter: BusinessLetter, datei: GespeichertesPdf | null):
  | { ok: true; document: CompanyDocument }
  | { ok: false; reason: 'archive_failed' } {
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
    ...(datei
      ? {
          fileRefId: datei.fileRefId,
          sourceFileHash: datei.contentHash,
          originalFileName: datei.fileName,
          mimeType: 'application/pdf',
          fileSize: datei.fileSize,
        }
      : {}),
  });

  if (!ergebnis.success) return { ok: false, reason: 'archive_failed' };

  const verknuepft = attachArchiveDocumentToLetter(letter.id, ergebnis.document.id);
  if (!verknuepft.success) return { ok: false, reason: 'archive_failed' };

  return { ok: true, document: ergebnis.document };
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

/**
 * 07B-FIX1 — die E-Mail-Adresse des Kunden, dem der Brief strukturell
 * zugeordnet ist: Archiveintrag → `linkedLetterId` → Brief → `customerId` →
 * Kundenstamm. Kein Namensabgleich, kein Raten über Firmennamen; ohne
 * Zuordnung oder ohne hinterlegte Adresse gibt es keine.
 */
export function resolveBusinessLetterCustomerEmail(document: CompanyDocument): string | null {
  const letter = getBusinessLetterForDocument(document);
  const customerId = letter?.customerId?.trim();
  if (!customerId) return null;
  const email = getCustomerById(customerId)?.email?.trim();
  return email ? email : null;
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
