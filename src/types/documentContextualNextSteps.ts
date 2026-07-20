export interface DocumentContextualNextStepsFact {
  readonly label: string;
  readonly value: string;
}

/**
 * Session-only, deterministic next-step suggestions for the consolidated assist flow.
 * Never persisted; never auto-executed.
 */
export interface DocumentContextualNextStepsViewModel {
  readonly suggestions: readonly string[];
  readonly missingOrUnconfirmed: readonly string[];
  readonly consideredFacts: readonly DocumentContextualNextStepsFact[];
}
