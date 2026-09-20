export interface ParsedDocumentAiAnswer {
  directAnswer: string;
  explanation: string;
  /**
   * DOKUMENT-ASSISTENT-01H3 — die Kennungen, die das Modell verwendet haben will.
   *
   * Eine Behauptung, kein Beleg. Geprüft wird sie erst danach gegen das, was
   * überhaupt vorgelegt wurde.
   */
  usedKnowledgeStatementIds?: string[];
  /** Combined prose for backward-compatible `text` consumers. */
  text: string;
}

function combine(directAnswer: string, explanation: string): string {
  if (!explanation) return directAnswer;
  if (!directAnswer) return explanation;
  return `${directAnswer}\n\n${explanation}`;
}

function fromParts(
  directAnswer: string,
  explanation: string,
  usedKnowledgeStatementIds?: string[],
): ParsedDocumentAiAnswer {
  const direct = directAnswer.trim();
  const expl = explanation.trim();
  return {
    directAnswer: direct,
    explanation: expl,
    text: combine(direct, expl),
    ...(usedKnowledgeStatementIds && usedKnowledgeStatementIds.length > 0
      ? { usedKnowledgeStatementIds }
      : {}),
  };
}

/** Nur Zeichenketten, nur getrimmt, keine Überraschungen. */
function readStatementIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * GESAMTABNAHME-01J — das erste vollständige Objekt, nicht die weiteste Spanne.
 *
 * In der Abnahme lieferte das Modell auf eine Frage **zwei** JSON-Blöcke
 * hintereinander. Die bisherige Suche nahm die erste öffnende und die letzte
 * schliessende Klammer — also beide Blöcke samt dem Text dazwischen, und das
 * ist kein gültiges JSON. Die Antwort fiel dadurch auf den Rohtext zurück,
 * und der Benutzer las geschweifte Klammern und Backticks.
 *
 * Deshalb wird jetzt geklammert gezählt: vom ersten `{` bis zu der Klammer,
 * die es wirklich schliesst. Zeichenketten werden dabei übersprungen, sonst
 * beendete eine Klammer im Antworttext das Objekt zu früh.
 */
function ersteObjektSpanne(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let tiefe = 0;
  let inText = false;
  let maskiert = false;

  for (let i = start; i < raw.length; i += 1) {
    const zeichen = raw[i];
    if (inText) {
      if (maskiert) maskiert = false;
      else if (zeichen === '\\') maskiert = true;
      else if (zeichen === '"') inText = false;
      continue;
    }
    if (zeichen === '"') inText = true;
    else if (zeichen === '{') tiefe += 1;
    else if (zeichen === '}') {
      tiefe -= 1;
      if (tiefe === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJsonObject(raw: string): ParsedDocumentAiAnswer | null {
  const spanne = ersteObjektSpanne(raw);
  if (!spanne) return null;

  try {
    const obj = JSON.parse(spanne) as {
      directAnswer?: unknown;
      explanation?: unknown;
      usedKnowledgeStatementIds?: unknown;
    };
    if (typeof obj.directAnswer !== 'string' || !obj.directAnswer.trim()) {
      return null;
    }
    const explanation = typeof obj.explanation === 'string' ? obj.explanation : '';
    return fromParts(
      obj.directAnswer,
      explanation,
      readStatementIds(obj.usedKnowledgeStatementIds),
    );
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
