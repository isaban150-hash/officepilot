import { COMMUNICATION_UNCERTAIN_HINT } from './communicationConstants';
import type {
  CommunicationContext,
  CommunicationRequest,
  DocumentQuestionResult,
  DocumentQuestionType,
} from '../types/communication';

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function detectDocumentQuestionType(userText: string): DocumentQuestionType {
  const text = normalize(userText);
  if (/was wollen die|was wollen sie|was wird verlangt|was verlangen/.test(text)) return 'what_wanted';
  if (/bis wann|frist|wann muss ich|deadline/.test(text)) return 'deadline';
  if (/unterlagen fehlen|was fehlt|fehlende unterlagen/.test(text)) return 'missing_docs';
  if (/nächstes tun|nächster schritt|was tun|was muss ich/.test(text)) return 'next_step';
  if (/wichtig|priorität|dringend/.test(text)) return 'importance';
  if (/formuliere.*antwort|schreib.*zurück|antwort entwerfen/.test(text)) return 'draft_reply';
  return 'custom';
}

function blockedResult(): DocumentQuestionResult {
  return {
    questionType: 'custom',
    answer: 'Analyse nicht möglich – Dokument scheint nicht firmenrelevant zu sein.',
    bullets: [],
    confidence: 'low',
    sources: [],
    uncertain: true,
  };
}

export function answerDocumentQuestion(
  request: CommunicationRequest,
  context: CommunicationContext,
): DocumentQuestionResult {
  if (!context.relevanceAllowed) {
    return blockedResult();
  }

  const questionType = detectDocumentQuestionType(request.userText);
  const letter = context.letterExplanation;
  const sources: string[] = [];
  let uncertain = false;

  if (questionType === 'what_wanted') {
    if (letter?.about) sources.push('letterExplanation.about');
    const answer = letter?.about
      ?? context.recognizedData?.Betreff
      ?? context.recognizedData?.betreff
      ?? `Basierend auf dem Dokumenttitel „${context.subject ?? 'unbekannt'}“. ${COMMUNICATION_UNCERTAIN_HINT}`;
    uncertain = !letter?.about;
    return {
      questionType,
      answer,
      bullets: letter ? [letter.about] : [],
      confidence: letter ? 'medium' : 'low',
      sources,
      uncertain,
    };
  }

  if (questionType === 'deadline') {
    if (letter?.deadline) sources.push('letterExplanation.deadline');
    if (context.recognizedData?.Frist) sources.push('recognizedData.Frist');
    const answer =
      letter?.deadline ??
      (context.recognizedData?.Frist
        ? `Im Text erkannte Frist: ${context.recognizedData.Frist}. Bitte im Original verifizieren.`
        : `Keine erkennbare Frist. ${COMMUNICATION_UNCERTAIN_HINT}`);
    uncertain = !context.recognizedData?.Frist && !letter?.deadline?.includes('Mögliche Frist');
    return {
      questionType,
      answer,
      bullets: [],
      confidence: uncertain ? 'low' : 'medium',
      sources,
      uncertain,
    };
  }

  if (questionType === 'missing_docs') {
    if (context.contractRequiredDocuments?.length) {
      sources.push('contractAnalysis.requiredDocuments');
      return {
        questionType,
        answer: 'Folgende Unterlagen könnten noch relevant sein (aus Vertragsanalyse):',
        bullets: context.contractRequiredDocuments,
        confidence: 'medium',
        sources,
        uncertain: true,
      };
    }
    return {
      questionType,
      answer: `Keine fehlenden Unterlagen automatisch erkannt. ${COMMUNICATION_UNCERTAIN_HINT}`,
      bullets: [],
      confidence: 'low',
      sources,
      uncertain: true,
    };
  }

  if (questionType === 'next_step') {
    if (letter?.nextSteps) sources.push('letterExplanation.nextSteps');
    const answer =
      letter?.nextSteps ??
      `Bitte Schreiben manuell prüfen und ggf. Fristen notieren. ${COMMUNICATION_UNCERTAIN_HINT}`;
    return {
      questionType,
      answer,
      bullets: letter ? [letter.nextSteps] : [],
      confidence: letter ? 'medium' : 'low',
      sources,
      uncertain: !letter,
    };
  }

  if (questionType === 'importance') {
    if (letter?.importance) sources.push('letterExplanation.importance');
    return {
      questionType,
      answer: letter?.importance ?? `Wichtigkeit unklar. ${COMMUNICATION_UNCERTAIN_HINT}`,
      bullets: [],
      confidence: letter ? 'medium' : 'low',
      sources,
      uncertain: !letter,
    };
  }

  if (questionType === 'draft_reply') {
    return {
      questionType,
      answer:
        'Bitte geben Sie Ihre Kernaussage an (z. B. „Unterlagen schicke ich nächste Woche“). OfficePilot formuliert daraus einen Antwortentwurf — ohne eigene Inhalte.',
      bullets: [],
      confidence: 'high',
      sources: ['communication.policy'],
      uncertain: false,
    };
  }

  if (letter) {
    sources.push('letterExplanation');
    return {
      questionType: 'custom',
      answer: letter.about,
      bullets: [letter.importance, letter.deadline, letter.nextSteps].filter(Boolean),
      confidence: 'medium',
      sources,
      uncertain: true,
    };
  }

  return {
    questionType: 'custom',
    answer: `Zu dieser Frage liegen keine ausreichenden Dokumentdaten vor. ${COMMUNICATION_UNCERTAIN_HINT}`,
    bullets: [],
    confidence: 'low',
    sources,
    uncertain: true,
  };
}
