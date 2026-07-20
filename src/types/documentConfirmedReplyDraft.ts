export interface DocumentConfirmedReplyDraftFact {
  readonly label: string;
  readonly value: string;
}

/**
 * Session-only reply draft from confirmed fill-confirm values.
 * Never persisted or sent.
 */
export interface DocumentConfirmedReplyDraft {
  readonly body: string;
  readonly considered: readonly DocumentConfirmedReplyDraftFact[];
  readonly notIncluded: readonly string[];
}
