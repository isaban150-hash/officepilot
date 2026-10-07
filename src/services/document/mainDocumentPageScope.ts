/**
 * EINGANG-02A-3 — welche Seiten gehören zum institutionellen Hauptschreiben?
 *
 * Ein Behörden- oder Versicherungsschreiben kommt oft mit einer fremden
 * Anlage: der Rechnung einer Werkstatt, dem Angebot eines Malerbetriebs. Bis
 * hierher wurde der ganze Text gelesen, und die Anlage bestimmte Dokumentart,
 * Rechnungsnummer, Betrag, Hauptfrist und Pflichten des Schreibens.
 *
 * Diese Datei entscheidet rein und deterministisch, ohne KI:
 *   - nur bei echter Seitenstruktur (mindestens zwei Seiten);
 *   - nur wenn Seite 1 einen institutionellen Briefkopf trägt (02A-1) und
 *     keine Gutschrift ist (01D-2 behält Vorrang);
 *   - eine spätere Seite ist nur dann sicher eine Fremdanlage, wenn ein
 *     fremder Firmenkopf UND ein eigener Dokumenttitel (Rechnung, Angebot,
 *     Kostenvoranschlag …) UND eine eigene Nummer oder Summenstruktur
 *     zusammenkommen. Ein Wort „Rechnung", ein Betrag oder ein
 *     Anlagenhinweis allein schneiden nie ab;
 *   - verdächtige, aber nicht sichere Seiten bleiben beim Hauptschreiben und
 *     werden nur als unsicher markiert.
 *
 * Gelesen wird nur; nichts wird gespeichert.
 */
import { detectFinanceDocumentMarkers } from './financeDocumentMarkers';
import { hasDunningTitle } from './dunningText';
import { hasComplaintTitle } from './complaintText';
import { isComplaintLetter } from './complaintLetter';
import { isOwnCompanySenderCandidate, resolveInstitutionalLetterhead } from './institutionalSenderTruth';
import { getCompanyProfile } from '../companyProfileService';
import type { SemanticPageScope } from '../../types/documentSemanticCore';

/** Seitentexte aus dem gespeicherten `_pageTexts`-JSON; nur ein gültiges JSON mit Text zählt. */
export function parseStoredPageTexts(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const pages = JSON.parse(raw) as Array<{ text?: unknown }>;
    if (!Array.isArray(pages)) return undefined;
    const texts = pages.map((page) => (typeof page?.text === 'string' ? page.text : ''));
    return texts.some((text) => text.trim()) ? texts : undefined;
  } catch {
    return undefined;
  }
}

/** Rechtsform eines Unternehmens in einer Kopfzeile. */
const FIRMEN_ZEILE = /\b(?:gmbh|mbh|ag|kg|kgaa|ohg|gbr|ug|se|e\.\s?k\.?)\b/i;
/** Ein eigener Dokumenttitel als eigene Zeile — nicht ein Wort im Fliesstext. */
const DOKUMENT_TITEL =
  /^(?:(?:werkstatt|reparatur|schluss|abschlags|teil|eingangs|handwerker)?rechnung|angebot|kostenvoranschlag|auftragsbest(?:ä|ae)tigung|lieferschein)\b(?:\s+(?:nr\.?|nummer)\s*[:#]?\s*\S+)?\s*$/i;
/** Eine eigene Dokumentnummer. */
const DOKUMENT_NUMMER =
  /\b(?:rechnungs|angebots|beleg|auftrags|kv)[\s-]*(?:nummer|nr\.?)\s*[:#]?\s*[A-Z0-9]|^(?:rechnung|angebot|kostenvoranschlag)\s+(?:nr\.?|nummer)\s*[:#]?\s*\S+/im;
/*
 * EINGANG-02C — ein eigenständiges Gutachten als Anlage einer Beschwerde: eigene
 * Titelzeile und eigene Gutachtennummer. Gilt nur im Beschwerdezweig.
 */
const GUTACHTEN_TITEL = /^(?:sachverst(?:ä|ae)ndigen|schadens?)?gutachten\b(?:\s+(?:nr\.?|nummer)\s*[:#]?\s*\S+)?\s*$/i;
const GUTACHTEN_NUMMER = /\bgutachten[\s-]*(?:nummer|nr\.?)\s*[:#]?\s*[A-Z0-9]/i;

/** Summenstruktur einer Rechnung oder eines Angebots. */
const SUMMEN_STRUKTUR = /\b(?:gesamtbetrag|rechnungsbetrag|endbetrag|angebotssumme|gesamtsumme|zwischensumme|mwst|ust\.?|netto|brutto)\b/i;

function zeilen(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((zeile) => zeile.trim())
    .filter(Boolean);
}

interface SeitenSignale {
  fremderKopf?: string;
  titel?: string;
  nummerOderSumme: boolean;
  institutionell: boolean;
}

function signaleDerSeite(text: string, hauptKopf: string | undefined, eigeneFirma: string): SeitenSignale {
  const z = zeilen(text);
  const kopf = z.slice(0, 4);
  const fremderKopf = kopf.find(
    (zeile) =>
      FIRMEN_ZEILE.test(zeile) &&
      zeile !== hauptKopf &&
      !resolveInstitutionalLetterhead(zeile, { ownCompanyName: eigeneFirma }) &&
      !isOwnCompanySenderCandidate(zeile, eigeneFirma),
  );
  const titel = z.slice(0, 8).find((zeile) => DOKUMENT_TITEL.test(zeile));
  return {
    ...(fremderKopf ? { fremderKopf } : {}),
    ...(titel ? { titel } : {}),
    nummerOderSumme: DOKUMENT_NUMMER.test(text) || SUMMEN_STRUKTUR.test(text),
    institutionell:
      Boolean(resolveInstitutionalLetterhead(text, { ownCompanyName: eigeneFirma })) ||
      Boolean(hauptKopf && z.slice(0, 4).includes(hauptKopf)),
  };
}

/**
 * Die Seitenrollen eines Eingangs — `undefined`, wenn nichts zu entscheiden
 * ist (eine Seite, kein institutioneller Briefkopf, Gutschrift, keine
 * verdächtige Seite). Seitennummern sind 1-basiert.
 */
export function resolveMainDocumentPageScope(
  pages: readonly string[] | undefined,
  options: { ownCompanyName?: string } = {},
): SemanticPageScope | undefined {
  if (!pages || pages.length < 2) return undefined;
  const erste = pages[0] ?? '';
  const eigeneFirma = options.ownCompanyName ?? getCompanyProfile().companyName;
  /*
   * EINGANG-02B — eine Mahnung (Titel auf Seite 1) mit beigefügter
   * Rechnungskopie: Die Kopie trägt denselben Lieferantenkopf, ist aber ein
   * eigener Beleg (Titelzeile + eigene Belegnummer). Sonst gilt die
   * institutionelle Regel aus 02A-3 unverändert.
   */
  const mahnung = hasDunningTitle(erste);
  /*
   * EINGANG-02C — ebenso eine Beschwerde/Reklamation/Mängelanzeige (Titel auf
   * Seite 1): Eine beigefügte Rechnungskopie oder ein Gutachten ist nur dann
   * Anlage, wenn die Seite eine eigene Dokumentidentität trägt (Titelzeile +
   * eigene Nummer) und selbst keine Beschwerde ist.
   */
  /* Nacharbeit 1 — mit Behörden-/Versicherungsbriefkopf gilt unverändert die 02A-3-Regel. */
  const beschwerde = !mahnung && isComplaintLetter(erste, { ownCompanyName: eigeneFirma });
  if (!mahnung && !beschwerde && !resolveInstitutionalLetterhead(erste, { ownCompanyName: eigeneFirma })) return undefined;
  if (detectFinanceDocumentMarkers(erste, { firstPageText: erste }).creditNoteHeader) return undefined;
  const hauptKopf = zeilen(erste)[0];

  const mainPageNumbers = [1];
  const attachmentPageNumbers: number[] = [];
  const uncertainPageNumbers: number[] = [];
  const evidence: SemanticPageScope['evidence'] = [];
  let inAnlage = false;

  pages.slice(1).forEach((text, offset) => {
    const seite = offset + 2;
    const s = signaleDerSeite(text, hauptKopf, eigeneFirma);
    const sicherFremd = mahnung
      ? Boolean(s.titel && DOKUMENT_NUMMER.test(text) && !hasDunningTitle(text))
      : beschwerde
        ? Boolean(
            (s.titel || zeilen(text).slice(0, 8).some((zeile) => GUTACHTEN_TITEL.test(zeile))) &&
              (DOKUMENT_NUMMER.test(text) || GUTACHTEN_NUMMER.test(text)) &&
              !hasComplaintTitle(text) &&
              !hasDunningTitle(text),
          )
        : Boolean(s.fremderKopf && s.titel && s.nummerOderSumme);
    if (sicherFremd) {
      inAnlage = true;
      attachmentPageNumbers.push(seite);
      evidence.push({ page: seite, role: 'attachment', ...(s.fremderKopf ? { header: s.fremderKopf } : {}), ...(s.titel ? { title: s.titel } : {}) });
      return;
    }
    if (inAnlage && !s.institutionell && !s.fremderKopf && !s.titel) {
      /* Folgeseite der Anlage: ohne eigenen Kopf, ohne Rückkehr zum Hauptschreiben. */
      attachmentPageNumbers.push(seite);
      evidence.push({ page: seite, role: 'attachment' });
      return;
    }
    mainPageNumbers.push(seite);
    /* Verdächtig, aber nicht sicher: bleibt beim Hauptschreiben, nur markiert. */
    if (s.titel || (s.fremderKopf && s.nummerOderSumme) || (inAnlage && !s.institutionell)) {
      uncertainPageNumbers.push(seite);
      evidence.push({ page: seite, role: 'uncertain', ...(s.fremderKopf ? { header: s.fremderKopf } : {}), ...(s.titel ? { title: s.titel } : {}) });
    }
  });

  if (attachmentPageNumbers.length === 0 && uncertainPageNumbers.length === 0) return undefined;
  return { mainPageNumbers, attachmentPageNumbers, uncertainPageNumbers, evidence };
}

/** Der Text der Hauptseiten — nur wenn eine Fremdanlage sicher abgegrenzt ist. */
export function mainDocumentTextFromPages(
  pages: readonly string[] | undefined,
  scope: SemanticPageScope | undefined,
): string | undefined {
  if (!pages || !scope || scope.attachmentPageNumbers.length === 0) return undefined;
  const text = scope.mainPageNumbers
    .map((seite) => pages[seite - 1] ?? '')
    .join('\n')
    .trim();
  return text || undefined;
}

/**
 * Die Textquellen für Lesekorpora, die `_extractedText`/`_vertragstext`
 * direkt verwenden: bei abgegrenzter Fremdanlage nur der Hauptdokumenttext,
 * sonst unverändert beide Felder.
 */
export function analysisTextsFromRecognizedData(
  daten: Record<string, string> | undefined,
  /** CLOUD-SYNC S4 — Nacharbeit 1: ausdrückliche Firmenidentität; ohne sie gilt das aktuelle Firmenprofil. */
  options: { ownCompanyName?: string } = {},
): Array<string | undefined> {
  const haupt = resolveMainDocumentFromRecognizedData(daten, options).text;
  return haupt ? [haupt] : [daten?._extractedText, daten?._vertragstext];
}

/*
 * CLOUD-SYNC S4 — Nacharbeit 1: Das Ergebnis hängt an den Seiten UND an der
 * eigenen Firma (fremder Kopf, institutioneller Briefkopf). Der Schlüssel
 * trägt deshalb beides — sonst bestimmte der erste Aufruf das Ergebnis für
 * jedes spätere Firmenprofil.
 */
const zwischenspeicher = new Map<string, { scope?: SemanticPageScope; text?: string }>();

/**
 * Seitenrollen und Hauptdokumenttext aus `recognizedData._pageTexts` — die
 * eine Stelle, über die Eingang, Analyse, Aufgaben und Archiv dieselbe
 * Hauptdokumentwahrheit lesen.
 */
export function resolveMainDocumentFromRecognizedData(
  daten: Record<string, string> | undefined,
  /** CLOUD-SYNC S4 — Nacharbeit 1: ausdrückliche Firmenidentität; ohne sie gilt das aktuelle Firmenprofil. */
  options: { ownCompanyName?: string } = {},
): { scope?: SemanticPageScope; text?: string } {
  const raw = daten?._pageTexts;
  if (!raw) return {};
  const eigeneFirma = options.ownCompanyName ?? getCompanyProfile().companyName;
  const schluessel = `${eigeneFirma}\u0000${raw}`;
  const bekannt = zwischenspeicher.get(schluessel);
  if (bekannt) return bekannt;
  const pages = parseStoredPageTexts(raw);
  const scope = resolveMainDocumentPageScope(pages, { ownCompanyName: eigeneFirma });
  const text = mainDocumentTextFromPages(pages, scope);
  const ergebnis = { ...(scope ? { scope } : {}), ...(text ? { text } : {}) };
  if (zwischenspeicher.size > 64) zwischenspeicher.clear();
  zwischenspeicher.set(schluessel, ergebnis);
  return ergebnis;
}
