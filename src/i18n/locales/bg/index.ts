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
import { bgSettings } from './settings';
import { bgSettingsHub } from './settingsHub';
import { bgSettingsProfile } from './settingsProfile';
import { bgDataDeletion } from './dataDeletion';
import { bgDataExport } from './dataExport';
import { bgLeaveGuard } from './leaveGuard';
import { bgDeviceData } from './deviceData';
import { bgErrors } from './errors';
import { bgEinrichtungNachtrag } from './einrichtungNachtrag';
import { bgDelivery } from './delivery';
import { bgFreeEmail } from './freeEmail';
import { bgInboundEmail } from './inboundEmail';
import { bgMailboxOAuth } from './mailboxOAuth';
import { bgBusinessLetter } from './businessLetter';
import { bgOffer } from './offer';
import { bgOrder } from './order';
import { bgDocumentMeaning } from './documentMeaning';
import { bgWorkspaceAccess } from './workspaceAccess';
import { bgLocalRecoveryAccess } from './localRecoveryAccess';
import { bgLocalRecoveryImport } from './localRecoveryImport';
import { bgAuthSession } from './authSession';
import { bgAccount } from './account';
import { bgSetupFlow } from './setupFlow';
import { bgPlatform } from './platform';
import { bgTeam } from './team';
import { bgExpenseTaxSplit } from './expenseTaxSplit';

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
  ...bgSettings,
  ...bgSettingsHub,
  ...bgSettingsProfile,
  ...bgDataDeletion,
  ...bgDataExport,
  ...bgLeaveGuard,
  ...bgDeviceData,
  ...bgErrors,
  ...bgEinrichtungNachtrag,
  ...bgDelivery,
  ...bgFreeEmail,
  ...bgInboundEmail,
  ...bgMailboxOAuth,
  ...bgBusinessLetter,
  ...bgOffer,
  ...bgOrder,
  ...bgDocumentMeaning,
  ...bgWorkspaceAccess,
  ...bgLocalRecoveryAccess,
  ...bgLocalRecoveryImport,
  ...bgAuthSession,
  ...bgAccount,
  ...bgSetupFlow,
  ...bgPlatform,
  ...bgTeam,
  ...bgExpenseTaxSplit,
} as const;
