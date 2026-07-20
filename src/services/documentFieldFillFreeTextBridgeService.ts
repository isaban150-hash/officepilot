import {
  extractFieldsWithConfidence,
  type ExtractedDocumentFields,
} from './documentFieldExtractionService';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type {
  DocumentFieldFillFreeTextBridgeFieldKey,
  DocumentFieldFillFreeTextBridgeParseResult,
  DocumentFieldFillFreeTextBridgeProposal,
} from '../types/documentFieldFillFreeTextBridge';

/** Word-boundary friendly for Latin letters (JS `\b` misses some cases). */
const WB = '(?:^|[^\\p{L}\\p{N}_])';

const QUESTION_WORD_PATTERN = new RegExp(
  `${WB}(?:wie|wann|welche[rs]?|wo|wer|was|warum|wieso|weshalb|womit|wodurch|inwiefern|ob)\\b`,
  'iu',
);

const QUESTION_START_PATTERN =
  /^(?:ist|sind|hat|haben|gibt|kann|können|muss|müssen|soll|sollte|sollten|wird|werden|darf|dürfen)\b/iu;

const DATE_VALUE = '(\\d{1,2}[./]\\d{1,2}[./]\\d{2,4})';

type LabeledRewrite = {
  fieldKey: DocumentFieldFillFreeTextBridgeFieldKey;
  labeledLine: string;
};

type StatementExtractor = {
  fieldKey: DocumentFieldFillFreeTextBridgeFieldKey;
  extract: (text: string) => string | undefined;
};

function normalizeBridgeAmount(raw: string): string {
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  const germanMoney =
    trimmed.match(/^(\d{1,3}(?:[.\s]\d{3})*,\d{2})\s*(€|EUR|eur)?$/i) ??
    trimmed.match(/^(\d{1,3}(?:[.\s]\d{3})*,\d{2})\s*(?:Euro)$/i);
  if (germanMoney?.[1]) {
    return `${germanMoney[1]} EUR`;
  }
  const whole = trimmed.match(/^(\d{1,3}(?:[.\s]\d{3})*)\s*(?:€|EUR|eur|Euro)$/i);
  if (whole?.[1]) {
    const digits = whole[1].replace(/\s/g, '');
    return `${digits},00 EUR`;
  }
  return trimmed;
}

/**
 * Rewrite natural-language statements into labeled lines so
 * `extractFieldsWithConfidence` can reuse existing patterns — one field per line.
 */
function rewriteStatementsToLabeledLines(text: string): LabeledRewrite[] {
  const lines: LabeledRewrite[] = [];
  const trimmed = text.trim();

  const invoice = trimmed.match(
    new RegExp(
      `${WB}(?:die\\s+)?rechnungs(?:nummer|nr\\.?)\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*([A-Z0-9][\\w./-]{1,})`,
      'iu',
    ),
  );
  if (invoice?.[1]) {
    lines.push({
      fieldKey: 'Rechnungsnummer',
      labeledLine: `Rechnungsnummer: ${invoice[1].trim()}`,
    });
  }

  const amount = trimmed.match(
    new RegExp(
      `${WB}(?:der\\s+)?betrag\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*(.+)$`,
      'iu',
    ),
  );
  if (amount?.[1]) {
    lines.push({
      fieldKey: 'Betrag',
      labeledLine: `Betrag: ${normalizeBridgeAmount(amount[1])}`,
    });
  }

  const deadline = trimmed.match(
    new RegExp(
      `${WB}(?:die\\s+)?frist\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*(?:der\\s+|den\\s+|am\\s+)?${DATE_VALUE}`,
      'iu',
    ),
  );
  if (deadline?.[1]) {
    lines.push({
      fieldKey: 'Frist',
      labeledLine: `Frist: ${deadline[1]}`,
    });
  }

  const date = trimmed.match(
    new RegExp(
      `${WB}(?:das\\s+)?datum\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*(?:der\\s+|den\\s+|am\\s+)?${DATE_VALUE}`,
      'iu',
    ),
  );
  if (date?.[1]) {
    lines.push({
      fieldKey: 'Datum',
      labeledLine: `Datum: ${date[1]}`,
    });
  }

  const sender = trimmed.match(
    new RegExp(
      `${WB}(?:der\\s+|die\\s+)?absender(?:in)?\\s*(?:(?:ist|lautet)\\s+|[=:])\\s*(.+)$`,
      'iu',
    ),
  );
  if (sender?.[1]) {
    lines.push({
      fieldKey: 'Absender',
      labeledLine: `Absender: ${sender[1].trim()}`,
    });
  }

  return lines;
}

const FALLBACK_EXTRACTORS: StatementExtractor[] = [
  {
    fieldKey: 'Rechnungsnummer',
    extract: (text) => {
      const match = text.match(
        new RegExp(
          `${WB}(?:die\\s+)?rechnungs(?:nummer|nr\\.?)\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*([A-Z0-9][\\w./-]{1,})`,
          'iu',
        ),
      );
      return match?.[1]?.trim();
    },
  },
  {
    fieldKey: 'Betrag',
    extract: (text) => {
      const match = text.match(
        new RegExp(
          `${WB}(?:der\\s+)?betrag\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*(.+)$`,
          'iu',
        ),
      );
      const raw = match?.[1]?.trim();
      return raw ? normalizeBridgeAmount(raw) : undefined;
    },
  },
  {
    fieldKey: 'Frist',
    extract: (text) => {
      const match = text.match(
        new RegExp(
          `${WB}(?:die\\s+)?frist\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*(?:der\\s+|den\\s+|am\\s+)?${DATE_VALUE}`,
          'iu',
        ),
      );
      return match?.[1]?.trim();
    },
  },
  {
    fieldKey: 'Datum',
    extract: (text) => {
      const match = text.match(
        new RegExp(
          `${WB}(?:das\\s+)?datum\\s*(?:(?:ist|beträgt|lautet)\\s+|[=:])\\s*(?:der\\s+|den\\s+|am\\s+)?${DATE_VALUE}`,
          'iu',
        ),
      );
      return match?.[1]?.trim();
    },
  },
  {
    fieldKey: 'Absender',
    extract: (text) => {
      const match = text.match(
        new RegExp(
          `${WB}(?:der\\s+|die\\s+)?absender(?:in)?\\s*(?:(?:ist|lautet)\\s+|[=:])\\s*(.+)$`,
          'iu',
        ),
      );
      return match?.[1]?.trim();
    },
  },
];

export function isFreeTextFieldBridgeQuestionLike(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes('?')) return true;
  if (QUESTION_START_PATTERN.test(trimmed)) return true;
  if (QUESTION_WORD_PATTERN.test(trimmed)) return true;
  return false;
}

function valueForScopedField(
  fieldKey: DocumentFieldFillFreeTextBridgeFieldKey,
  labeledLine: string,
): string | undefined {
  const extracted = extractFieldsWithConfidence(labeledLine);
  const fromExtraction = extracted[fieldKey as keyof ExtractedDocumentFields]?.value?.trim();
  if (fromExtraction) {
    return fromExtraction;
  }
  // Keep only the intended key even when extraction also fills siblings (e.g. Datum from Frist line).
  const colonValue = labeledLine.split(':').slice(1).join(':').trim();
  return colonValue || undefined;
}

function collectScopeMatches(text: string): Map<DocumentFieldFillFreeTextBridgeFieldKey, string> {
  const matches = new Map<DocumentFieldFillFreeTextBridgeFieldKey, string>();

  for (const rewrite of rewriteStatementsToLabeledLines(text)) {
    const value = valueForScopedField(rewrite.fieldKey, rewrite.labeledLine);
    if (value) {
      matches.set(rewrite.fieldKey, value);
    }
  }

  for (const extractor of FALLBACK_EXTRACTORS) {
    if (matches.has(extractor.fieldKey)) continue;
    const value = extractor.extract(text);
    if (value) {
      matches.set(extractor.fieldKey, value);
    }
  }

  return matches;
}

/**
 * Parse free text for a unique in-scope field statement.
 * Questions / no match / ambiguous → not a bridge proposal.
 */
export function parseFreeTextFieldBridge(
  text: string,
): DocumentFieldFillFreeTextBridgeParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: 'none' };
  }

  if (isFreeTextFieldBridgeQuestionLike(trimmed)) {
    return { kind: 'question' };
  }

  const matches = collectScopeMatches(trimmed);
  if (matches.size === 0) {
    return { kind: 'none' };
  }
  if (matches.size > 1) {
    return { kind: 'ambiguous' };
  }

  const [fieldKey, value] = [...matches.entries()][0]!;
  return {
    kind: 'field_statement',
    fieldKey,
    value,
  };
}

/**
 * Apply a free-text proposal into local fill-confirm rows.
 * Never overwrites confirmed rows; never sets confirmed.
 */
export function applyFreeTextBridgeProposalToRows(
  rows: readonly DocumentFieldFillConfirmRow[],
  proposal: DocumentFieldFillFreeTextBridgeProposal,
): DocumentFieldFillConfirmRow[] {
  const value = proposal.value.trim();
  if (!value) {
    return [...rows];
  }

  return rows.map((row) => {
    if (row.fieldKey !== proposal.fieldKey) {
      return row;
    }
    if (row.status === 'confirmed') {
      return row;
    }
    return Object.freeze({
      fieldKey: row.fieldKey,
      label: row.label,
      proposedValue: value,
      confidence: 'medium' as const,
      status: 'proposed' as const,
      bridgedFromFreeText: true,
    });
  });
}
