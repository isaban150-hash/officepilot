import { deAuth } from './auth';
import { deCommon } from './common';
import { deDynamic } from './dynamic';
import { deHome } from './home';
import { deDocumentExplanation, deLetterExplanation } from './letterExplanation';
import { deLanguage } from './language';
import { deOverlay } from './overlay';
import { deScan } from './scan';
import { deIntakePreview } from './intakePreview';
import { deStorageRecommendation } from './storageRecommendation';

export const deModules = {
  ...deAuth,
  ...deCommon,
  ...deDynamic,
  ...deHome,
  ...deLanguage,
  ...deLetterExplanation,
  ...deDocumentExplanation,
  ...deOverlay,
  ...deScan,
  ...deIntakePreview,
  ...deStorageRecommendation,
} as const;
