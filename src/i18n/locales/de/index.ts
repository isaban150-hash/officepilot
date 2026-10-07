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
} as const;
