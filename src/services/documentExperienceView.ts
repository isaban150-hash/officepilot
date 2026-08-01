/**
 * DOCUMENT-SUMMARY — thin compatibility adapter.
 * First-screen logic lives in buildDocumentSummary; this only maps to the legacy view shape for tests.
 */
import type { TranslationKey } from '../i18n';
import type { LetterExplanation } from './letterExplanationService';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type { InboxItem, WorkflowResult } from '../types/models';
import {
  buildDocumentSummary,
  resolveDocumentSummaryAlertLabel,
  resolveDocumentSummaryFactLabel,
  resolveDocumentSummaryFamily,
} from './documentSummary';
import type { DocumentSummaryFamily } from '../types/documentSummary';

export type DocumentExperienceFamily = Exclude<DocumentSummaryFamily, 'contract'>;

export type DocumentExperienceFactView = {
  id: string;
  label: string;
  value: string;
};

export type DocumentExperienceAlertView = {
  id: string;
  label: string;
};

export type DocumentExperienceSecondaryId = 'later' | 'link_vorgang' | 'create_task';

export type DocumentExperienceView = {
  present: boolean;
  family: DocumentExperienceFamily | 'contract';
  documentTypeLabel: string;
  headline: string;
  facts: DocumentExperienceFactView[];
  alerts: DocumentExperienceAlertView[];
  primaryActionLabel: string;
  secondaryActions: Array<{ id: DocumentExperienceSecondaryId; label: string }>;
  /** Soft next-step text for Details (not BI jargon). */
  nextStep?: string;
};

export function resolveDocumentExperienceFamily(
  item: InboxItem,
  workflow: WorkflowResult,
): DocumentExperienceFamily | 'contract' {
  return resolveDocumentSummaryFamily(item, workflow);
}

/**
 * @deprecated Prefer buildDocumentSummary — kept as a thin delegate for existing tests.
 */
export function buildDocumentExperienceView(
  item: InboxItem,
  workflow: WorkflowResult,
  options: {
    translate: (key: TranslationKey) => string;
    displayBusinessInterpretation?: BusinessInterpretationResult | null;
    letter?: LetterExplanation | null;
  },
): DocumentExperienceView {
  const summary = buildDocumentSummary(item, workflow, {
    translate: options.translate,
    displayBusinessInterpretation: options.displayBusinessInterpretation,
    letter: options.letter,
  });
  const translate = options.translate;
  const nextStep = summary.details.find((d) => d.id === 'nextStep')?.proseText;

  return {
    present: true,
    family: summary.family,
    documentTypeLabel: translate(summary.documentTypeLabelKey),
    headline: summary.headline,
    facts: summary.facts.map((f) => ({
      id: f.id,
      label: resolveDocumentSummaryFactLabel(f, translate),
      value: f.value,
    })),
    alerts: summary.alerts.map((a) => ({
      id: a.id,
      label: resolveDocumentSummaryAlertLabel(a, translate),
    })),
    primaryActionLabel: translate(summary.primaryAction.labelKey),
    secondaryActions: summary.secondaryActions
      .filter(
        (a): a is typeof a & { id: DocumentExperienceSecondaryId } =>
          a.id === 'later' || a.id === 'link_vorgang' || a.id === 'create_task',
      )
      .map((a) => ({
        id: a.id,
        label: translate(a.labelKey),
      })),
    nextStep,
  };
}
