/**
 * EINGANG-01D-1 — deterministische Merkmale für Gutschrift, Korrektur und
 * Abrechnungsgutschrift.
 *
 * Bisher reichte das Wort „Gutschrift" irgendwo im Text für die Dokumentart
 * `gutschrift` — auch eine Buchungszeile im Kontoauszug oder der Hinweis einer
 * Rechnung auf eine frühere Gutschrift. Hier zählt nur, was das Dokument
 * **selbst** ist: sein Kopf (Titelzeile, eigene Gutschriftsnummer).
 *
 * Drei Ergebnisse, mit klarer Rangfolge:
 *   selfBillingCredit  — Gutschrift im Abrechnungsverfahren (§ 14 Abs. 2 UStG):
 *                        der Kunde rechnet über **unsere** Leistung ab — für uns
 *                        ein Erlös, nie eine Ausgabe. → prüfen
 *   invoiceCorrection  — eingehende Rechnungskorrektur / Stornorechnung: bezieht
 *                        sich auf eine vorhandene Rechnung, ist keine zweite
 *                        Verbindlichkeit. → prüfen
 *   creditNoteHeader   — normale Lieferantengutschrift.
 *
 * Bewusst konservativ: Was hier nicht eindeutig erkannt wird, bleibt bei der
 * bisherigen Klassifikation. Die eigene Firma als Leistende wird nicht
 * geraten — dafür fehlt am Eingang eine sichere Grundlage.
 */

export interface FinanceDocumentMarkers {
  creditNoteHeader: boolean;
  invoiceCorrection: boolean;
  selfBillingCredit: boolean;
}

/** Der Kopf eines Dokuments: die ersten Zeilen mit Inhalt. */
const HEAD_LINE_COUNT = 12;

/**
 * Seite 1, wenn sie nicht gesondert vorliegt: großzügig, damit ein
 * Rechnungstitel unter einem langen Briefkopf (Zeile 13 ff.) noch zählt.
 */
const FIRST_PAGE_FALLBACK_LINE_COUNT = 60;

const INVOICE_TITLE_LINE = /^(?:rechnung|eingangsrechnung|schlussrechnung|abschlagsrechnung|teilrechnung)\b/;
/** Titelzeile „Gutschrift …" — aber nicht die Beschriftung „Gutschrift-Nr." selbst. */
const CREDIT_TITLE_LINE = /^gutschrift(?!s?[\s-]*(?:nummer|nr\b))(?:\s|$|[:#\-–/])/;
/** Eigene Gutschriftsnummer als Zeilenbeschriftung, nicht als Verweis im Fließtext. */
const CREDIT_NUMBER_LABEL_LINE = /^gutschrift(?:s)?(?:nummer|[\s-]*nr\.?)\s*[:#]?\s*[a-z0-9]/;
/** Starke Merkmale, dass das Dokument **selbst** eine Rechnung ist. */
const INVOICE_NUMBER_LABEL = /\brechnungs[\s-]*(?:nummer|nr\b)/;
const PAYMENT_TERM = /\bzahlbar\s+bis\b/;
const BANK_STATEMENT = /kontoauszug|kontostand|alter saldo|neuer saldo|buchungstag|valuta|kontoumsätze|kontoumsaetze/;
const CORRECTION_HEAD =
  /\b(?:rechnungskorrektur|korrekturrechnung|stornorechnung|storno-rechnung|rechnungsstorno)\b|^storno\b|\bstorno\s+(?:zu|zur|der)\s+rechnung\b/;
const SELF_BILLING_EXPLICIT = /gutschriftsverfahren|abrechnungsgutschrift|gutschrift\s+im\s+sinne\s+(?:des|von)\s+§\s*14/;
const SELF_BILLING_PARAGRAPH = /§\s*14\s*abs(?:atz|\.)?\s*2\b[^\n]{0,30}\bustg/;

function normalizeLines(text: string): string[] {
  return text
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

export function detectFinanceDocumentMarkers(
  text: string | undefined | null,
  options: { firstPageText?: string | null } = {},
): FinanceDocumentMarkers {
  const none: FinanceDocumentMarkers = { creditNoteHeader: false, invoiceCorrection: false, selfBillingCredit: false };
  const lines = normalizeLines(text ?? '');
  if (lines.length === 0) return none;
  const all = lines.join('\n');
  const head = lines.slice(0, HEAD_LINE_COUNT);
  const firstPageLines = options.firstPageText?.trim()
    ? normalizeLines(options.firstPageText)
    : lines.slice(0, FIRST_PAGE_FALLBACK_LINE_COUNT);

  const mentionsCredit = /gutschrift/.test(all);
  const selfBillingCredit =
    SELF_BILLING_EXPLICIT.test(all) || (mentionsCredit && SELF_BILLING_PARAGRAPH.test(all));
  const invoiceCorrection = head.some((line) => CORRECTION_HEAD.test(line));

  let creditNoteHeader = false;
  if (mentionsCredit && !BANK_STATEMENT.test(all)) {
    /*
     * EINGANG-01D-1 Nacharbeit — Dokumentidentität statt Erwähnung.
     *
     * Eine Gutschrift darf auf eine Rechnung verweisen („zu Rechnung RE-1"),
     * und eine Rechnung darf eine Gutschrift erwähnen („verrechnet mit
     * Gutschrift-Nr. GS-5"). Entscheidend ist, was das Dokument **selbst** ist:
     *   - Titelzeile „Gutschrift" im Kopf, vor jedem Rechnungstitel auf Seite 1;
     *     eine Seite mit Rechnungstitel **und** „zahlbar bis" ist eine Rechnung;
     *   - oder eine eigene Gutschriftsnummer als Kopfzeile, wenn Seite 1 weder
     *     Rechnungstitel noch Zahlungsziel und der Kopf keine
     *     Rechnungsnummer-Beschriftung trägt.
     * Der Rechnungstitel zählt auf ganz Seite 1, nicht nur in den ersten Zeilen.
     */
    /*
     * Nacharbeit 2 (P2) — ohne echte Seitengrenzen ist „Seite 1" nur geschätzt
     * (die ersten 60 Zeilen) und kann schon eine angehängte Kopie der
     * Originalrechnung enthalten. Diese unsichere Evidenz darf eine im Kopf
     * erkannte Gutschrift-Titelzeile nicht in eine automatisch buchbare
     * Rechnung umdrehen; im Zweifel gilt der Gutschriftweg (Formular,
     * Bestätigung). Mit echten Seitentexten gilt die volle Seite-1-Regel.
     */
    const hasRealFirstPage = Boolean(options.firstPageText?.trim());
    const firstPage = firstPageLines.join('\n');
    const firstInvoiceTitle = firstPageLines.findIndex((line) => INVOICE_TITLE_LINE.test(line));
    const invoiceIdentity = hasRealFirstPage && firstInvoiceTitle !== -1 && PAYMENT_TERM.test(firstPage);
    const firstCreditTitle = head.findIndex((line) => CREDIT_TITLE_LINE.test(line));
    const titledAsCredit =
      firstCreditTitle !== -1 &&
      (firstInvoiceTitle === -1 || firstCreditTitle < firstInvoiceTitle) &&
      !invoiceIdentity;
    const numberEvidenceLines = hasRealFirstPage ? firstPageLines : head;
    const numberedAsCredit =
      head.some((line) => CREDIT_NUMBER_LABEL_LINE.test(line)) &&
      !numberEvidenceLines.some((line) => INVOICE_TITLE_LINE.test(line)) &&
      !PAYMENT_TERM.test(numberEvidenceLines.join('\n')) &&
      !INVOICE_NUMBER_LABEL.test(head.join('\n'));
    creditNoteHeader = titledAsCredit || numberedAsCredit;
  }

  return { creditNoteHeader, invoiceCorrection, selfBillingCredit };
}

/** Der strukturierte Prüfhinweis, falls das Dokument nicht gebucht werden darf. */
export function resolveFinanceReviewReason(
  markers: FinanceDocumentMarkers,
): 'self_billing_credit' | 'invoice_correction' | null {
  if (markers.selfBillingCredit) return 'self_billing_credit';
  if (markers.invoiceCorrection) return 'invoice_correction';
  return null;
}
