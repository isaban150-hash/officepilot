/**
 * DOKUMENT-ASSISTENT-01H2B — die Regel steht nicht mehr hier.
 *
 * In 01H2 wurde sie an dieser Stelle geschrieben. 01H2 hat dabei selbst
 * festgestellt, dass eine Schranke im Browser umgehbar ist: Wer den
 * KI-Endpunkt unmittelbar anspricht, bekommt die Antwort ungeprüft.
 *
 * Deshalb liegt die Einordnung jetzt in
 * `supabase/functions/_shared/legalClaimCore.ts` — dort, wo die Edge Function
 * sie erreicht und der Client ebenso. Dieselbe Datei, dieselben Muster,
 * dieselbe Entscheidung. Es gibt keine Client-Fassung und keine
 * Server-Fassung; es gibt nur eine.
 *
 * Diese Datei bleibt bestehen, damit der Clientpfad seinen gewohnten Namen
 * behält. Sie enthält bewusst **keine** eigene Logik: Eine zweite Zeile Regel
 * an dieser Stelle wäre der Anfang des Auseinanderlaufens.
 */
export type {
  GuardedAnswer,
  LegalClaimClass,
  LegalClaimFinding,
  LegalClaimReview,
} from '../../../supabase/functions/_shared/legalClaimCore';

export {
  classifyLegalClaim,
  guardAiAnswerText,
  isServerClaimGuardedOperation,
  NEUTRAL_CLAIM_FALLBACK_TEXT,
  reviewAiAnswerText,
  reviewLegalClaims,
  SERVER_CLAIM_GUARDED_OPERATIONS,
  splitIntoClaimSegments,
} from '../../../supabase/functions/_shared/legalClaimCore';
