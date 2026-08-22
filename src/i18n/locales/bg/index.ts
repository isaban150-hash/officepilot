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
import { bgIntakePreview, bgDocumentFacts } from './intakePreview';
import { bgStorageRecommendation } from './storageRecommendation';
import { bgUserStorageDecision } from './userStorageDecision';
import { bgDocumentOriginal } from './documentOriginal';
import { bgBackup } from './backup';
import { bgPilot } from './pilot';

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
  ...bgDocumentFacts,
  ...bgStorageRecommendation,
  ...bgUserStorageDecision,
  ...bgDocumentOriginal,
  ...bgBackup,
  ...bgPilot,
} as const;
