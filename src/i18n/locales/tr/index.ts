import { trAuth } from './auth';
import { trCommon } from './common';
import { trDynamic } from './dynamic';
import { trHome } from './home';
import { trDocumentExplanation, trLetterExplanation, trLetterLabels, trDocAssistantCore } from './letterExplanation';
import { trIntakeUnderstanding } from './intakeUnderstanding';
import { trLanguage } from './language';
import { trScan } from './scan';
import { trIntakePreview } from './intakePreview';
import { trStorageRecommendation } from './storageRecommendation';

export const trModules = {
  ...trAuth,
  ...trCommon,
  ...trDynamic,
  ...trHome,
  ...trIntakeUnderstanding,
  ...trLanguage,
  ...trLetterExplanation,
  ...trDocumentExplanation,
  ...trLetterLabels,
  ...trDocAssistantCore,
  ...trScan,
  ...trIntakePreview,
  ...trStorageRecommendation,
} as const;
