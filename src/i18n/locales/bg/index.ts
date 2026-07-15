import { bgAuth } from './auth';
import { bgCommon } from './common';
import { bgDocAssistant } from './docAssistant';
import { bgDynamic } from './dynamic';
import { bgHome } from './home';
import { bgDocAssistantCore, bgDocumentExplanation, bgLetterExplanation, bgLetterLabels, bgNavigation } from './letterExplanation';
import { bgIntakeUnderstanding } from './intakeUnderstanding';
import { bgLanguage } from './language';
import { bgReviewWorkflow } from './reviewWorkflow';
import { bgScan } from './scan';
import { bgIntakePreview } from './intakePreview';

export const bgModules = {
  ...bgAuth,
  ...bgCommon,
  ...bgDocAssistant,
  ...bgDynamic,
  ...bgHome,
  ...bgIntakeUnderstanding,
  ...bgLanguage,
  ...bgLetterExplanation,
  ...bgDocumentExplanation,
  ...bgLetterLabels,
  ...bgNavigation,
  ...bgDocAssistantCore,
  ...bgReviewWorkflow,
  ...bgScan,
  ...bgIntakePreview,
} as const;
