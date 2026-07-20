import {
  DOCUMENT_FIELD_FILL_CONFIRM_RELEVANT_KEYS,
  getConfirmedFillConfirmValues,
} from './documentFieldFillConfirmService';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { DocumentConfirmedReplyDraft } from '../types/documentConfirmedReplyDraft';
import type { ClassifiedDocumentKind, InboxItem } from '../types/models';

/** Classified kinds treated as Behörde for this sprint. */
const BEHOERDE_CLASSIFIED_KINDS = new Set<ClassifiedDocumentKind>([
  'zoll',
  'handwerkskammer',
  'ihk',
  'gewerbeamt',
  'bauamt',
  'ordnungsamt',
  'agentur_fuer_arbeit',
  'deutsche_rentenversicherung',
  'finanzamt',
  'berufsgenossenschaft',
]);

const DIRECT_SCOPE_KINDS = new Set<ClassifiedDocumentKind>([
  'bg_bau',
  'mahnung',
  'zahlungserinnerung',
]);

/**
 * Reply-draft panel is only offered for Behörde, BG BAU, Mahnung, Zahlungserinnerung.
 */
export function isConfirmedReplyDraftSupported(item: InboxItem): boolean {
  const kind = item.classifiedKind;
  if (kind && DIRECT_SCOPE_KINDS.has(kind)) return true;
  if (kind && BEHOERDE_CLASSIFIED_KINDS.has(kind)) return true;
  if (item.documentType === 'behoerde') return true;
  return false;
}

export function listNotIncludedRelevantLabels(
  rows: readonly DocumentFieldFillConfirmRow[],
): string[] {
  const byKey = new Map(rows.map((row) => [row.fieldKey, row]));
  const labels: string[] = [];
  for (const key of DOCUMENT_FIELD_FILL_CONFIRM_RELEVANT_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      labels.push(key);
      continue;
    }
    if (row.status === 'confirmed' && row.confirmedValue?.trim()) {
      continue;
    }
    labels.push(row.label);
  }
  return labels;
}

export interface BuildConfirmedReplyDraftInput {
  readonly coreMessage: string;
  readonly subject?: string | null;
  readonly sender?: string | null;
  readonly rows: readonly DocumentFieldFillConfirmRow[];
}

/**
 * Deterministic local reply draft. Does not invent greetings, facts, or intent.
 * Returns null when core message is empty.
 */
export function buildConfirmedReplyDraft(
  input: BuildConfirmedReplyDraftInput,
): DocumentConfirmedReplyDraft | null {
  const core = input.coreMessage.trim();
  if (!core) {
    return null;
  }

  const considered = getConfirmedFillConfirmValues(input.rows).map((entry) =>
    Object.freeze({ label: entry.label, value: entry.value }),
  );
  const notIncluded = listNotIncludedRelevantLabels(input.rows);

  const lines: string[] = [];
  const subject = input.subject?.trim();
  const sender = input.sender?.trim();
  if (subject) {
    lines.push(`Bezug: ${subject}`);
  }
  if (sender) {
    lines.push(`Schreiben von: ${sender}`);
  }
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push(core);

  return Object.freeze({
    body: lines.join('\n'),
    considered: Object.freeze(considered),
    notIncluded: Object.freeze(notIncluded),
  });
}

export function formatConfirmedReplyDraftClipboardText(
  draft: DocumentConfirmedReplyDraft,
): string {
  const parts = [draft.body];
  if (draft.considered.length > 0) {
    parts.push(
      '',
      'Berücksichtigt:',
      ...draft.considered.map((fact) => `- ${fact.label}: ${fact.value}`),
    );
  }
  if (draft.notIncluded.length > 0) {
    parts.push('', 'Nicht enthalten:', ...draft.notIncluded.map((label) => `- ${label}`));
  }
  return parts.join('\n');
}
