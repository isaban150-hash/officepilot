import { deAuth } from './auth';
import { deCommon } from './common';
import { deDynamic } from './dynamic';
import { deHome } from './home';
import { deDocumentExplanation, deLetterExplanation } from './letterExplanation';
import { deLanguage } from './language';
import { deOverlay } from './overlay';
import { deScan } from './scan';
import { deIntakePreview, deDocumentFacts } from './intakePreview';
import { deStorageRecommendation } from './storageRecommendation';
import { deUserStorageDecision } from './userStorageDecision';
import { deDocumentOriginal } from './documentOriginal';
import { deBackup } from './backup';
import { dePilot } from './pilot';

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
  ...deDocumentFacts,
  ...deStorageRecommendation,
  ...deUserStorageDecision,
  ...deDocumentOriginal,
  ...deBackup,
  ...dePilot,
} as const;
