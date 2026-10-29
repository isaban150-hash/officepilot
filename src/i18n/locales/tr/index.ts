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
import { trSettings } from './settings';
import { trSettingsHub } from './settingsHub';
import { trSettingsProfile } from './settingsProfile';
import { trDataDeletion } from './dataDeletion';
import { trDataExport } from './dataExport';
import { trLeaveGuard } from './leaveGuard';
import { trDeviceData } from './deviceData';
import { trErrors } from './errors';
import { trEinrichtungNachtrag } from './einrichtungNachtrag';
import { trDelivery } from './delivery';
import { trFreeEmail } from './freeEmail';
import { trInboundEmail } from './inboundEmail';
import { trMailboxOAuth } from './mailboxOAuth';
import { trBusinessLetter } from './businessLetter';
import { trOffer } from './offer';
import { trOrder } from './order';
import { trDocumentMeaning } from './documentMeaning';
import { trWorkspaceAccess } from './workspaceAccess';
import { trLocalRecoveryAccess } from './localRecoveryAccess';
import { trLocalRecoveryImport } from './localRecoveryImport';
import { trAuthSession } from './authSession';
import { trAccount } from './account';
import { trSetupFlow } from './setupFlow';
import { trPlatform } from './platform';
import { trTeam } from './team';
import { trExpenseTaxSplit } from './expenseTaxSplit';

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
  ...trSettings,
  ...trSettingsHub,
  ...trSettingsProfile,
  ...trDataDeletion,
  ...trDataExport,
  ...trLeaveGuard,
  ...trDeviceData,
  ...trErrors,
  ...trEinrichtungNachtrag,
  ...trDelivery,
  ...trFreeEmail,
  ...trInboundEmail,
  ...trMailboxOAuth,
  ...trBusinessLetter,
  ...trOffer,
  ...trOrder,
  ...trDocumentMeaning,
  ...trWorkspaceAccess,
  ...trLocalRecoveryAccess,
  ...trLocalRecoveryImport,
  ...trAuthSession,
  ...trAccount,
  ...trSetupFlow,
  ...trPlatform,
  ...trTeam,
  ...trExpenseTaxSplit,
} as const;
