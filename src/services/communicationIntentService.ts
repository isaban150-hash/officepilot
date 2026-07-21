import type { CommunicationContext, CommunicationIntent, RewriteStyle } from '../types/communication';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\wäöüß0-9\s?]/gi, ' ')
    .replace(/\s+/g, ' ');
}

export function detectRewriteStyle(userText: string): RewriteStyle | undefined {
  const text = normalize(userText);
  if (/höflich/.test(text)) return 'polite';
  if (/bestimm/.test(text)) return 'assertive';
  if (/professionell/.test(text)) return 'professional';
  if (/kürzer|kurzer/.test(text)) return 'shorter';
  if (/ausführlich|länger/.test(text)) return 'longer';
  if (/freundlich/.test(text)) return 'friendly';
  return undefined;
}

export function detectCommunicationIntent(
  userText: string,
  context?: CommunicationContext,
): CommunicationIntent {
  const text = normalize(userText);

  if (
    /was wollen die|was wollen sie|was wird verlangt|was verlangen die|was soll ich tun/.test(text)
  ) {
    return 'document_question';
  }
  if (/bis wann|frist|deadline|wann muss ich/.test(text) && context?.letterExplanation) {
    return 'document_question';
  }
  if (/welche unterlagen fehlen|was fehlt noch|fehlende unterlagen/.test(text)) {
    return 'document_question';
  }
  if (/was muss ich als nächstes|nächster schritt|was tun/.test(text) && context?.letterExplanation) {
    return 'document_question';
  }
  if (/ist das wichtig|wie wichtig|priorität/.test(text) && context?.letterExplanation) {
    return 'document_question';
  }
  if (/formuliere.*antwort|schreib.*zurück|antwort.*schreiben/.test(text)) {
    return context?.letterExplanation ? 'document_reply' : 'document_question';
  }

  if (/übersetze|übersetzung|translate/.test(text)) return 'translate_message';

  if (/umschreib|rewrite|höflicher|bestimmter|professioneller|kürzer|ausführlicher|freundlicher/.test(text)) {
    return 'rewrite_message';
  }

  if (/verbessere|korrigiere|optimiere|rechtschreib/.test(text)) return 'improve_text';

  if (/preis.*erhöh|preiserhöhung|teurer|preis anpassen/.test(text)) return 'price_adjustment';
  if (/stornier|auftrag.*absagen|bestellung.*storn/.test(text)) return 'cancel_order';
  if (/angebot.*ablehn|decline|absage.*angebot/.test(text)) return 'decline_offer';
  if (/termin.*verschieb|termin.*änder|terminänderung|neuer termin/.test(text)) return 'appointment_change';
  if (/verzöger|verspät|delay|später fertig|verzug/.test(text)) return 'delay_notice';
  if (/zusätzlich|mehrarbeit|nachtrag|zusatzleistung/.test(text)) return 'additional_work';
  if (/mahnung/.test(text)) {
    return 'dunning_notice';
  }
  if (/zahlungserinnerung|zahlung.*erinnern|offene rechnung/.test(text)) {
    return 'payment_reminder';
  }
  if (/rechnung.*nachfrage|rechnung.*follow|nachfrage.*rechnung/.test(text)) return 'invoice_followup';

  if (/antwort.*brief|antwort.*schreiben|dokument.*antwort/.test(text)) return 'document_reply';
  if (/frage.*brief|frage.*dokument|was steht im brief/.test(text)) return 'document_question';

  if (context?.letterExplanation && text.includes('?')) return 'document_question';

  return 'unknown';
}

export function isDocumentQuestionIntent(intent: CommunicationIntent): boolean {
  return intent === 'document_question';
}

export function isDraftIntent(intent: CommunicationIntent): boolean {
  return !['document_question', 'unknown'].includes(intent);
}
