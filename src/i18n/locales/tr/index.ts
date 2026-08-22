import { trAuth } from './auth';
import { trCommon } from './common';
import { trDynamic } from './dynamic';
import { trHome } from './home';
import { trDocumentExplanation, trLetterExplanation, trLetterLabels, trDocAssistantCore } from './letterExplanation';
import { trIntakeUnderstanding } from './intakeUnderstanding';
import { trLanguage } from './language';
import { trScan } from './scan';
import { trIntakePreview, trDocumentFacts } from './intakePreview';
import { trStorageRecommendation } from './storageRecommendation';
import { trUserStorageDecision } from './userStorageDecision';
import { trDocumentOriginal } from './documentOriginal';
import { trBackup } from './backup';
import { trPilot } from './pilot';

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
  ...trDocumentFacts,
  ...trStorageRecommendation,
  ...trUserStorageDecision,
  ...trDocumentOriginal,
  ...trBackup,
  ...trPilot,
} as const;
