export interface ParsedDocumentAiAnswer {
  directAnswer: string;
  explanation: string;
  /** Combined prose for backward-compatible `text` consumers. */
  text: string;
}

function combine(directAnswer: string, explanation: string): string {
  if (!explanation) return directAnswer;
  if (!directAnswer) return explanation;
  return `${directAnswer}\n\n${explanation}`;
}

function fromParts(directAnswer: string, explanation: string): ParsedDocumentAiAnswer {
  const direct = directAnswer.trim();
  const expl = explanation.trim();
  return {
    directAnswer: direct,
    explanation: expl,
    text: combine(direct, expl),
  };
}

function tryParseJsonObject(raw: string): ParsedDocumentAiAnswer | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      directAnswer?: unknown;
      explanation?: unknown;
    };
    if (typeof obj.directAnswer !== 'string' || !obj.directAnswer.trim()) {
      return null;
    }
    const explanation = typeof obj.explanation === 'string' ? obj.explanation : '';
    return fromParts(obj.directAnswer, explanation);
  } catch {
    return null;
  }
}

function tryParseLabeled(raw: string): ParsedDocumentAiAnswer | null {
  const labeled = raw.match(
    /(?:^|\n)\s*(?:KERN|DIREKT|DIRECT)\s*:\s*([\s\S]*?)(?:\n\s*(?:ERKLÄRUNG|ERKLAERUNG|BEGRÜNDUNG|BEGRUENDUNG|EXPLANATION)\s*:\s*([\s\S]*))?$/i,
  );
  if (!labeled?.[1]?.trim()) return null;
  return fromParts(labeled[1], labeled[2] ?? '');
}

/**
 * Splits model output into a short core answer and a document-grounded explanation.
 * Prefers explicit JSON / labeled markers; falls back to first-sentence split.
 */
export function parseDocumentAiAnswer(raw: string): ParsedDocumentAiAnswer {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { directAnswer: '', explanation: '', text: '' };
  }

  const fromJson = tryParseJsonObject(trimmed);
  if (fromJson) return fromJson;

  const fromLabeled = tryParseLabeled(trimmed);
  if (fromLabeled) return fromLabeled;

  const sentence = trimmed.match(/^([\s\S]+?[.!?…])(?:\s+([\s\S]*))?$/u);
  if (sentence?.[1]) {
    return fromParts(sentence[1], sentence[2] ?? '');
  }

  return fromParts(trimmed, '');
}
