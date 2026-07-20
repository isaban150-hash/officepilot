import { listNotIncludedRelevantLabels } from './documentConfirmedReplyDraftService';
import { getConfirmedFillConfirmValues } from './documentFieldFillConfirmService';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { DocumentContextualNextStepsViewModel } from '../types/documentContextualNextSteps';

const MAX_SUGGESTIONS = 5;

const FACT_HINT_KEYS = new Set(['Frist', 'Betrag', 'Aktenzeichen']);

export interface BuildDocumentContextualNextStepsInput {
  readonly rows: readonly DocumentFieldFillConfirmRow[];
  /** Optional user goal from the reply panel; empty → no reply intent assumed. */
  readonly coreMessage?: string;
  readonly hasReplyDraft: boolean;
}

/**
 * Deterministic local next-step view-model.
 * Uses only confirmed fill-confirm values as facts — never proposed/OCR/unconfirmed.
 */
export function buildDocumentContextualNextSteps(
  input: BuildDocumentContextualNextStepsInput,
): DocumentContextualNextStepsViewModel {
  const consideredFacts = getConfirmedFillConfirmValues(input.rows).map((entry) =>
    Object.freeze({ label: entry.label, value: entry.value }),
  );
  const missingOrUnconfirmed = listNotIncludedRelevantLabels(input.rows);
  const coreMessage = input.coreMessage?.trim() ?? '';
  const suggestions: string[] = [];

  if (missingOrUnconfirmed.length > 0) {
    suggestions.push('Fehlende oder unbestätigte Angaben prüfen oder ergänzen.');
  }

  if (consideredFacts.length > 0) {
    suggestions.push('Bestätigte Angaben nochmals kontrollieren.');
  }

  if (coreMessage && !input.hasReplyDraft) {
    suggestions.push('Antwortentwurf vorbereiten.');
  }

  if (input.hasReplyDraft) {
    suggestions.push('Im Kommunikationsbereich prüfen.');
  }

  for (const fact of consideredFacts) {
    if (!FACT_HINT_KEYS.has(fact.label)) continue;
    suggestions.push(
      `Bestätigte Angabe „${fact.label}: ${fact.value}“ im Entwurf berücksichtigen.`,
    );
  }

  return Object.freeze({
    suggestions: Object.freeze(suggestions.slice(0, MAX_SUGGESTIONS)),
    missingOrUnconfirmed: Object.freeze([...missingOrUnconfirmed]),
    consideredFacts: Object.freeze(consideredFacts),
  });
}

/** Guard for tests/UI: no duty / payment / legal imperative wording. */
export function contextualNextStepsTextLooksUnsafe(text: string): boolean {
  return (
    /\bSie müssen\b/i.test(text) ||
    /\bZahlen\b.*\bbis\b/i.test(text) ||
    /\bWidersprechen\b.*\bbis\b/i.test(text) ||
    /\bRechtsfolge/i.test(text) ||
    /\bpflichtig\b/i.test(text) ||
    /\bverpflichtet\b/i.test(text)
  );
}
