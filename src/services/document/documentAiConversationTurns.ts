/**
 * DOCUMENT-ASSIST-02B — ephemeral prior turns for document free questions.
 * Pure helpers only. Never persist. Never write TruthView / overlay / stores.
 */
import type { DocumentAiPriorTurn } from '../../types/areaAi';

/** Complete user+assistant rounds retained in memory (deterministic cap). */
export const DOCUMENT_AI_MAX_PRIOR_ROUNDS = 4;

/** Max characters per turn text after deterministic truncation. */
export const DOCUMENT_AI_MAX_TURN_CHARS = 600;

const MAX_PRIOR_TURN_ENTRIES = DOCUMENT_AI_MAX_PRIOR_ROUNDS * 2;

function truncateTurnText(text: string, max = DOCUMENT_AI_MAX_TURN_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/**
 * Clone + truncate + keep last N rounds. Does not mutate input.
 */
export function normalizeDocumentAiPriorTurns(
  turns: readonly DocumentAiPriorTurn[] | null | undefined,
): DocumentAiPriorTurn[] {
  if (!turns || turns.length === 0) return [];
  const normalized: DocumentAiPriorTurn[] = turns.map((turn) => ({
    role: turn.role,
    text: truncateTurnText(turn.text ?? ''),
    ...(turn.uncertain ? { uncertain: true as const } : {}),
    ...(turn.uncertaintyNotes && turn.uncertaintyNotes.length > 0
      ? { uncertaintyNotes: [...turn.uncertaintyNotes] }
      : {}),
  }));
  return normalized.filter((turn) => turn.text.length > 0).slice(-MAX_PRIOR_TURN_ENTRIES);
}

/**
 * Prompt section lines — dialog only, never document truth.
 */
export function formatDocumentAiPriorTurnsForPrompt(
  turns: readonly DocumentAiPriorTurn[],
): string[] {
  const normalized = normalizeDocumentAiPriorTurns(turns);
  return normalized.map((turn, index) => {
    let body: string;
    if (turn.role === 'user') {
      body = `Nutzer (unbestätigt, Dialog): ${turn.text}`;
    } else {
      const uncertain =
        turn.uncertain === true
          ? ' [UNSICHER — keine sichere Faktquelle; Vermutungen nicht verfestigen]'
          : ' [Assistent — nachrangig; keine Dokumentenwahrheit]';
      const notes =
        turn.uncertaintyNotes && turn.uncertaintyNotes.length > 0
          ? ` Hinweise: ${turn.uncertaintyNotes.join('; ')}`
          : '';
      body = `Assistent${uncertain}: ${turn.text}${notes}`;
    }
    return `${index + 1}. ${body}`;
  });
}

/**
 * Guard-allowed dialog text: user turns only.
 * Assistant speculation must not authorize new amounts/dates.
 * Normalizes "300 Euro" / "300 EUR" so QA amount extraction can see `300 €`.
 */
export function buildDocumentAiPriorTurnsGuardText(
  turns: readonly DocumentAiPriorTurn[] | null | undefined,
): string {
  return normalizeDocumentAiPriorTurns(turns)
    .filter((turn) => turn.role === 'user')
    .map((turn) =>
      turn.text.replace(
        /(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)\s*(?:€|eur|euro)\b/gi,
        (match, amount: string) => `${match} ${amount} €`,
      ),
    )
    .join('\n');
}

export function appendDocumentAiConversationTurn(
  existing: readonly DocumentAiPriorTurn[],
  next: DocumentAiPriorTurn,
): DocumentAiPriorTurn[] {
  return normalizeDocumentAiPriorTurns([...existing, next]);
}

/**
 * DOCUMENT-ASSIST-02C — only successful AI answers enter dialog history.
 * Technical unavailable / guard / empty failures must not create turns.
 */
export function shouldPersistDocumentAiConversationExchange(answer: {
  source: string;
}): boolean {
  return answer.source === 'ai';
}
