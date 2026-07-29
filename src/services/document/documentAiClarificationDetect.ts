/**
 * DOCUMENT-ASSIST-02C — detect genuine clarification answers (not bare "?") for post-check sparing.
 * Pure helpers. No TruthView / overlay writes.
 */

/** Overclaim / obligation patterns that must never be spared from post-check softening. */
const OVERCLAIM_OR_OBLIGATION =
  /(?:sie\s+müssen|müssen\s+sie|sie\s+sind\s+verpflichtet|zahlungspflicht(?:ig)?|rechts?\s*verbindlich|verbindliche\s+forderung|dokument\s+fordert|fordert\s+eine\s+zahlung|zahlungsfrist\s+ist|frist\s+für\s+die\s+überweisung|reaktionsfrist\s+ist|müssen\s+(?:sie\s+)?(?:zahlen|überweisen|reagieren))/iu;

/** Names a concrete missing or ambiguous fact (not a generic checklist). */
const NAMES_CONCRETE_GAP =
  /(?:bereits\s+gezahlt|gezahlte[rn]?\s+betrag|teilzahlung|offene[rn]?\s+rest|welches\s+(?:datum|schreiben|datum|termin)|welche[rn]?\s+(?:betrag|frist|passage|datum|absatz)|wer\s+(?:dies|das|es|Ihnen)\s+gesagt|wann\s+(?:dies|das|es|gesprochen)|schriftliche?\s+bestätigung|nicht\s+(?:eindeutig|sicher|klar)\s+(?:erkennbar|bekannt|belegt)|im\s+dokument\s+fehlt|fehlt\s+(?:im\s+dokument|eine?\s+angabe)|unklar(?:er)?\s+(?:bezug|betrag|frist|datum)|mehrdeutig|nicht\s+bekannt|telefonisch(?:e)?\s+(?:zusage|aussage))/iu;

/** Concrete clarifying question (not mere "Bitte?" / "Welche?"). */
const CONCRETE_CLARIFYING_QUESTION =
  /(?:wie\s+viel(?:\s+haben\s+sie)?|welchen?\s+betrag|welches\s+(?:datum|schreiben)|welche\s+(?:passage|frist|angabe)|wer\s+hat(?:\s+(?:dies|das|es))?\s+gesagt|wann\s+(?:wurde|haben|ist|gesagt)|ob\s+(?:eine\s+)?schriftlich|an\s+welchem\s+tag|bis\s+zu\s+welchem\s+datum)/iu;

/**
 * True when the answer is a genuine targeted clarification:
 * names a concrete gap + asks a concrete follow-up, without overclaims.
 * A lone "?" or generic "Bitte …?" does not qualify.
 */
export function isGenuineDocumentAiClarificationAnswer(text: string): boolean {
  const combined = text.trim();
  if (!combined || !combined.includes('?')) return false;
  if (OVERCLAIM_OR_OBLIGATION.test(combined)) return false;
  if (!NAMES_CONCRETE_GAP.test(combined)) return false;
  if (!CONCRETE_CLARIFYING_QUESTION.test(combined)) return false;
  return true;
}

/**
 * Softening spare: genuine clarification without overclaim patterns.
 */
export function shouldSpareDocumentAiPostCheckSoftening(text: string): boolean {
  return isGenuineDocumentAiClarificationAnswer(text);
}

/** Count `?` sentences roughly for test assertions (max 3 preferred). */
export function countDocumentAiClarificationQuestionMarks(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}
