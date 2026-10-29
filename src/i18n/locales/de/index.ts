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
import { deSettings } from './settings';
import { deSettingsHub } from './settingsHub';
import { deSettingsProfile } from './settingsProfile';
import { deDataDeletion } from './dataDeletion';
import { deDataExport } from './dataExport';
import { deLeaveGuard } from './leaveGuard';
import { deDeviceData } from './deviceData';
import { deErrors } from './errors';
import { deDelivery } from './delivery';
import { deFreeEmail } from './freeEmail';
import { deInboundEmail } from './inboundEmail';
import { deMailboxOAuth } from './mailboxOAuth';
import { deBusinessLetter } from './businessLetter';
import { deOffer } from './offer';
import { deOrder } from './order';
import { deDocumentMeaning } from './documentMeaning';
import { deIntakeAssessment } from './intakeAssessment';
import { deInvoiceDraftCloud } from './invoiceDraftCloud';
import { deOrderDraftCloud } from './orderDraftCloud';
import { deReplyNeed } from './replyNeed';
import { deEmployeePayments } from './employeePayments';
import { deWorkspaceRole } from './workspaceRole';
import { deDocumentRetention } from './documentRetention';
import { deSyncHeldOrders } from './syncHeldOrders';
import { deVorgangsbindung } from './vorgangsbindung';
import { deWorkspaceAccess } from './workspaceAccess';
import { deLocalRecoveryAccess } from './localRecoveryAccess';
import { deLocalRecoveryImport } from './localRecoveryImport';
import { deAuthSession } from './authSession';
import { deAccount } from './account';
import { deSetupFlow } from './setupFlow';
import { dePlatform } from './platform';
import { deTeam } from './team';
import { deExpenseTaxSplit } from './expenseTaxSplit';

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
  ...deSettings,
  ...deSettingsHub,
  ...deSettingsProfile,
  ...deDataDeletion,
  ...deDataExport,
  ...deLeaveGuard,
  ...deDeviceData,
  ...deErrors,
  ...deDelivery,
  ...deFreeEmail,
  ...deInboundEmail,
  ...deMailboxOAuth,
  ...deBusinessLetter,
  ...deOffer,
  ...deOrder,
  ...deDocumentMeaning,
  ...deIntakeAssessment,
  ...deInvoiceDraftCloud,
  ...deOrderDraftCloud,
  ...deReplyNeed,
  ...deEmployeePayments,
  ...deWorkspaceRole,
  ...deDocumentRetention,
  ...deSyncHeldOrders,
  ...deVorgangsbindung,
  ...deWorkspaceAccess,
  ...deLocalRecoveryAccess,
  ...deLocalRecoveryImport,
  ...deAuthSession,
  ...deAccount,
  ...deSetupFlow,
  ...dePlatform,
  ...deTeam,
  ...deExpenseTaxSplit,
} as const;
