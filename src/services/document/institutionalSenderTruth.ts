/**
 * EINGANG-02A-1 — Absenderwahrheit bei Behörden- und Versicherungsschreiben.
 *
 * Ein solches Schreiben kommt immer von außen. Fiel die Briefkopf-Erkennung
 * auf die eigene Firma im Empfängerblock zurück, wird der Absender ohne die
 * eigene Firma neu bestimmt — sonst bleibt er offen. Erfunden wird nichts.
 *
 * Bewusst eng:
 * - nur Behörden- und Versicherungsarten (Gutschriften, Rechnungen und eigene
 *   Ausgangsdokumente bleiben unberührt);
 * - ein ausdrücklicher Absender-Hinweis (z. B. aus der E-Mail oder der
 *   gespeicherte Absender bei der Neuklassifikation) bleibt Absender; nur
 *   Absender-Feld und Profil-Absender werden bereinigt;
 * - steht die eigene Firma selbst als erste Zeile im Briefkopf, ist es ein
 *   eigenes Schreiben, und sie bleibt Absender.
 */
import { isOwnCompanyName } from '../customerOwnCompanyGuard';
import { normalizeCompanyIdentityValue } from '../companyRelevanceService';
import {
  cleanLetterheadCandidate,
  inferUnlabeledSenderFromText,
  isMunicipalLetterheadLine,
} from '../documentFieldExtractionService';
import { isAuthorityClassifiedKind, isInsuranceClassifiedKind } from '../businessInterpretationMeaning';
import { CLASSIFICATION_RULES } from '../documentClassificationCatalog';
import { getCompanyProfile } from '../companyProfileService';
import type { ClassifiedDocumentKind } from '../../types/models';

/**
 * Dieselbe Identität wie `isOwnCompanyParty` (Schritt A): volle Gleichheit nach
 * der kanonischen Namensfaltung; zusätzlich ohne Satzzeichen, damit
 * „GmbH & Co. KG" und „GmbH & Co KG" dieselbe Firma bleiben. Kein Teilstring.
 */
export function isOwnCompanySenderCandidate(
  candidate: string | undefined | null,
  ownCompanyName: string | undefined | null,
): boolean {
  if (!candidate?.trim() || !ownCompanyName?.trim()) return false;
  if (isOwnCompanyName(candidate, ownCompanyName)) return true;
  const own = normalizeCompanyIdentityValue(ownCompanyName);
  return Boolean(own) && normalizeCompanyIdentityValue(candidate) === own;
}

/** Die Kopfzeile eines Dokuments: seine erste nicht leere Zeile. */
function letterheadLine(text: string | undefined): string | undefined {
  return (text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function ownCompanyIsLetterhead(text: string, ownCompanyName: string): boolean {
  const firstLine = letterheadLine(text);
  if (!firstLine) return false;
  return isOwnCompanySenderCandidate(cleanLetterheadCandidate(firstLine) ?? firstLine, ownCompanyName);
}

export type InstitutionalLetterhead = {
  /** Behörden-/Versicherungsart laut Katalog; fehlt z. B. bei „Stadt Musterstadt". */
  kind?: ClassifiedDocumentKind;
  reasonKey?: string;
};

/**
 * EINGANG-02A-1 Nacharbeit 3 — stammt das Dokument laut Briefkopf von einer
 * Behörde oder Versicherung? Gemeinsame Schutzwahrheit für Klassifikation,
 * Vertrags-Gate und Vertragsanalyse.
 *
 * Gelesen werden nur zwei Quellen:
 * - die Kopfzeile des Dokuments (erste nicht leere Zeile) — nie der
 *   Fließtext, nie der Empfängerblock;
 * - ein ausdrücklicher Absender-Hinweis (`senderHint` der Aufnahme, z. B. der
 *   E-Mail-Absender) — nie ein aus dem Text abgeleiteter Wert.
 *
 * Institutionell ist eine Quelle, wenn sie auf ein Katalogmuster einer
 * Behörden- oder Versicherungsart passt („LVM Versicherung", „Finanzamt …",
 * „Berufsgenossenschaft …") oder ein kommunaler Briefkopf ist („Stadt
 * Musterstadt", „Gemeinde …"). Die eigene Firma ist nie institutioneller
 * Fremdabsender.
 */
export function resolveInstitutionalLetterhead(
  text: string | undefined,
  options: { senderHint?: string; ownCompanyName?: string } = {},
): InstitutionalLetterhead | null {
  const ownCompanyName = options.ownCompanyName ?? getCompanyProfile().companyName;
  for (const source of [letterheadLine(text), options.senderHint?.trim()]) {
    if (!source) continue;
    if (isOwnCompanySenderCandidate(cleanLetterheadCandidate(source) ?? source, ownCompanyName)) continue;
    const value = source.toLowerCase();
    const rule = CLASSIFICATION_RULES.find(
      (candidate) =>
        (isAuthorityClassifiedKind(candidate.kind) || isInsuranceClassifiedKind(candidate.kind)) &&
        candidate.pattern.test(value),
    );
    if (rule) return { kind: rule.kind, reasonKey: rule.reasonKey };
    if (isMunicipalLetterheadLine(source)) return {};
  }
  return null;
}

export function hasInstitutionalLetterhead(
  text: string | undefined,
  options: { senderHint?: string; ownCompanyName?: string } = {},
): boolean {
  return resolveInstitutionalLetterhead(text, options) !== null;
}

/**
 * Behörden- oder Versicherungskorrespondenz: institutionelle Dokumentart ODER
 * institutioneller Briefkopf. Die Art allein reicht als Schutzquelle nicht —
 * frühere Katalogregeln („Abnahmeprotokoll", „Arbeitsvertrag") oder ein
 * Briefkopf ohne Katalogart („Stadt Musterstadt") würden sie verfehlen.
 */
export function isInstitutionalCorrespondence(
  kind: ClassifiedDocumentKind | undefined,
  text: string | undefined,
): boolean {
  if (kind && (isAuthorityClassifiedKind(kind) || isInsuranceClassifiedKind(kind))) return true;
  return hasInstitutionalLetterhead(text);
}

export type InstitutionalSenderInput = {
  classifiedKind: ClassifiedDocumentKind;
  recognizedText?: string;
  senderHint?: string;
  sender: string;
  recognizedData: Record<string, string>;
  senderEntity?: string;
  ownCompanyName?: string;
  unknownSender: string;
};

export type InstitutionalSenderTruth = {
  sender: string;
  recognizedData: Record<string, string>;
  senderEntity?: string;
};

/*
 * EINGANG-02C — auch ein Schreiben ohne Beleg-Art (Beschwerde, Mängelanzeige,
 * Brief einer Privatperson) hat nie die eigene Firma aus dem Empfängerblock
 * als Absender. Steht der eigene Betrieb als Briefkopf oben, bleibt er
 * Absender (eigenes Schreiben). Belegarten wie Rechnung oder Angebot bleiben
 * unberührt — dort kann die eigene Firma rechtmäßig Aussteller sein.
 */
const FREMDE_SCHREIBEN: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'sonstiges',
  'schriftverkehr',
  'brief',
  'email_pdf',
  'maengelprotokoll',
]);

/** `null` = nichts zu korrigieren; die Eingabe gilt unverändert. */
export function resolveInstitutionalSenderTruth(
  input: InstitutionalSenderInput,
): InstitutionalSenderTruth | null {
  const own = input.ownCompanyName?.trim();
  const text = input.recognizedText?.trim();
  if (!own || !text) return null;
  if (
    !isAuthorityClassifiedKind(input.classifiedKind) &&
    !isInsuranceClassifiedKind(input.classifiedKind) &&
    !FREMDE_SCHREIBEN.has(input.classifiedKind)
  ) {
    return null;
  }
  const isOwn = (value: string | undefined) => isOwnCompanySenderCandidate(value, own);
  const { recognizedData } = input;
  if (
    !isOwn(input.sender) &&
    !isOwn(input.senderEntity) &&
    !isOwn(recognizedData.Absender) &&
    !isOwn(recognizedData.Lieferant)
  ) {
    return null;
  }
  if (ownCompanyIsLetterhead(text, own)) return null;

  /*
   * Nacharbeit 3 — ist die Kopfzeile selbst institutionell („LVM Versicherung"
   * ohne Rechtsform), ist sie der Absender. Sonst griffe die Rechtsform-Suche
   * auf eine Firma aus dem Fließtext („Ihr Auftraggeber, die … GmbH").
   */
  const headLine = letterheadLine(text);
  const institutionalHead =
    headLine && hasInstitutionalLetterhead(text, { ownCompanyName: own })
      ? (cleanLetterheadCandidate(headLine) ?? headLine)
      : undefined;
  const external =
    institutionalHead ?? inferUnlabeledSenderFromText(text, { excludeCandidate: (candidate) => isOwn(candidate) });
  const nextData = { ...recognizedData };
  for (const key of ['Absender', 'Lieferant'] as const) {
    if (!isOwn(nextData[key])) continue;
    if (external) nextData[key] = external;
    else delete nextData[key];
  }
  /*
   * Der Profil-Absender trägt die korrigierte Wahrheit immer mit — auch als
   * „nicht erkannt". Bliebe er leer, griffe die Verständnis-Zusammenfassung
   * auf ihre eigene Roh-Extraktion zurück und zeigte wieder die eigene Firma.
   */
  const keepEntity = input.senderEntity?.trim() && !isOwn(input.senderEntity);
  // Ein ausdrücklicher Hinweis (E-Mail, gespeicherter Absender) bleibt Absender.
  const keepSender = Boolean(input.senderHint?.trim()) || !isOwn(input.sender);
  return {
    sender: keepSender ? input.sender : (external ?? input.unknownSender),
    recognizedData: nextData,
    senderEntity: keepEntity ? input.senderEntity : (external ?? input.unknownSender),
  };
}
