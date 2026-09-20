import type { DocumentAiContext } from '../../types/areaAi';

const WB = '(?:^|[^\\p{L}\\p{N}_])';

const PAYMENT_DEMAND_PATTERN = new RegExp(
  `${WB}(?:zahlungsaufforderung|zahlungserinnerung|mahnung|bitte\\s+(?:überweisen|zahlen|begleichen)|sofort\\s+zahlbar|zahlbar\\s+bis|fällig\\s+am|fälligkeit|zu\\s+zahlen|überweisen\\s+sie|ödeme\\s+yapın|lütfen\\s+öde|ödeme\\s+hatırlat|borç\\s+ihbar|платежно\\s+напомняне|моля\\s+платете|дължима\\s+сума|заплатате)`,
  'iu',
);

const RESPONSE_DEMAND_PATTERN = new RegExp(
  `${WB}(?:bitte\\s+(?:reagieren|antworten|rückmelden|einreichen|zurücksenden)|reaktionsfrist|antwortfrist|einreichungsfrist|rückmeldung\\s+bis|innerhalb\\s+von\\s+\\d+\\s*tagen\\s+(?:zu\\s+)?(?:antworten|reagieren|melden)|yanıt\\s+verin|cevap\\s+ver|başvuru\\s+yapın|моля\\s+отговорете|срок\\s+за\\s+отговор|подайте)`,
  'iu',
);

/** Structured deadline evidence only — not issueDate/documentDate/OCR alone. */
export function hasStructuredDeadlineEvidence(context: DocumentAiContext): boolean {
  /*
   * DOKUMENT-ASSISTENT-01E — die verstandene Bedeutung ist ebenfalls ein Beleg.
   *
   * Der Kern aus 01B führt jede Frist mit Typ und Belegstelle. Sie hier nicht
   * zu zählen hiess, eine belegte Frist als unbelegt zu behandeln.
   */
  if (context.semantic && context.semantic.deadlines.length > 0) return true;
  return Boolean(context.deadline?.trim() || context.validUntil?.trim());
}

export function hasPaymentDemandEvidence(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  return PAYMENT_DEMAND_PATTERN.test(text);
}

export function hasResponseDemandEvidence(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  return RESPONSE_DEMAND_PATTERN.test(text);
}

export function hasDemandEvidence(context: DocumentAiContext): boolean {
  /*
   * DOKUMENT-ASSISTENT-01E — eine gelesene Pflicht ist eine Aufforderung.
   *
   * Die Muster oben suchen feste Wendungen wie „bitte antworten". „Wir fordern
   * Sie auf, die Mängel bis zum 30.09.2026 zu beseitigen" steht in keiner von
   * ihnen — die Aufforderung galt deshalb als unbelegt, und eine richtige
   * Antwort wurde auf eine vorsichtige Schablone zurückgestuft.
   *
   * Der semantische Kern hat die Pflicht samt Belegstelle gelesen. Nur was er
   * dem eigenen Betrieb zuschreibt, zählt hier; was die Gegenseite ankündigt,
   * ist keine Aufforderung an uns.
   */
  const semantic = context.semantic;
  if (semantic) {
    if (semantic.obligations.some((pflicht) => pflicht.who === 'own_company')) return true;
    if (semantic.deadlines.some((frist) => frist.actionRequired)) return true;
  }

  const text = [
    context.recognizedText ?? '',
    ...context.recognizedDataLines,
    context.letterSummary?.about ?? '',
    context.letterSummary?.nextSteps ?? '',
    context.title,
  ].join('\n');
  return hasPaymentDemandEvidence(text) || hasResponseDemandEvidence(text);
}

export function canClaimDocumentDemandWithDate(context: DocumentAiContext): boolean {
  return hasStructuredDeadlineEvidence(context) && hasDemandEvidence(context);
}

/** Dates that may be mentioned as OCR/field values (stage 1), not as payment due dates alone. */
export function collectMentionableDates(context: DocumentAiContext): string[] {
  const dates: string[] = [];
  const push = (value?: string | null) => {
    const trimmed = value?.trim();
    if (trimmed) dates.push(trimmed);
  };
  push(context.deadline);
  push(context.validUntil);
  push(context.issueDate);
  const text = context.recognizedText ?? '';
  for (const match of text.matchAll(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g)) {
    dates.push(match[0]);
  }
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    dates.push(match[0]);
  }
  return Array.from(new Set(dates));
}
