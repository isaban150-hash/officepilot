/** Keys that must exist for DE, TR and BG without silent German fallback in tests. */

export const CORE_I18N_PATHS = [

  // Navigation

  'nav.schreibtisch',

  'nav.dokumente',

  'nav.auftraege',

  'nav.officepilot',

  'nav.mehr',

  // Auth

  'auth.login.title',

  'auth.login.subtitle',

  'auth.login.email',

  'auth.login.password',

  'auth.login.submit',

  'auth.login.submitting',

  'auth.login.forgotPassword',

  'auth.login.register',

  'auth.register.title',

  'auth.register.submit',

  'auth.forgotPassword.title',

  'auth.accessBlocked.title',

  'auth.error.invalidCredentials',

  'auth.error.passwordMismatch',

  'auth.error.registrationSuccess',

  // Global states

  'common.loading.app',

  'common.loading.auth',

  'common.close',

  'common.back',

  'common.cancel',

  'common.misc',

  'common.unknownSender',

  // Language

  'language.title',

  'language.de',

  'language.tr',

  'language.bg',

  'language.saved',

  'language.previewNotice',

  // Home / scan entry

  'mobile.home.addDocument',

  'heute.scanButton',

  'scan.title',

  'scan.subtitle',

  'scan.captureTitle',

  'scan.captureHint',

  'scan.camera',

  'scan.gallery',

  'scan.pdf',

  'scan.uploadFile',

  'scan.typeAuto',

  'scan.ocr.processing',

  'scan.ocr.previewSubtitle',

  'scan.ocr.continue',

  'scan.ocr.documentType',

  'scan.ocr.sender',

  'scan.ocr.previewText',

  'scan.ocr.partialHint',

  'scan.ocr.noText',

  'scan.ocr.unsupportedFormat',

  'scan.ocr.failed',

  'scanResult.toastRecognized',

  // Upload kinds

  'uploadKind.auftrag',

  'uploadKind.zahlungserinnerung',

  'uploadKind.materialrechnung',

  'uploadKind.bg_bau',

  'uploadKind.werbung',

  'uploadKind.kontoauszug',

  // Document intake / preview

  'document.intakeUnderstanding.title',

  'document.intakeUnderstanding.partialHint',

  'document.intakeUnderstanding.amount',

  'document.intakeUnderstanding.deadline',

  'document.intakeUnderstanding.aiActions',

  'document.intakeUnderstanding.uncertainHint',

  // Upload errors

  'document.upload.error.processFailed',

  'docAssistant.error.retry',

  'docAssistant.error.newPhoto',

  'docAssistant.error.selectFile',

  'docAssistant.error.title.noReadableText',

  'docAssistant.error.title.technicalFailure',

  // Document assistant core

  'docAssistant.section.brief',

  'docAssistant.section.actions',

  'docAssistant.section.questions',

  'docAssistant.section.trust',

  'docAssistant.section.filing',

  'docAssistant.section.original',

  'docAssistant.section.steuerberater',

  'docAssistant.recognized',

  'docAssistant.changeType',

  'docAssistant.question.pay',

  'docAssistant.question.why',

  'docAssistant.question.deadline',

  'docAssistant.question.ignore',

  'docAssistant.question.tax',

  'docAssistant.question.file',

  'docAssistant.question.dispose',

  'docAssistant.answer.aiUnavailable',

  'docAssistant.original.keep',

  'docAssistant.steuerberater.mark',

  'docAssistant.trust.confident',

  'docAssistant.trust.review',

  // Review workflow core

  'reviewWorkflow.hero.title',

  'reviewWorkflow.recommend.title',

  'reviewWorkflow.action.applySuggestion',

  'reviewWorkflow.check.title',

  // Paper filing & legal

  'paperFiling.instruction',

  'legal.disclaimer',

  'inbox.securityHintBody',

  'priority.mittel',

  'inboxStatus.neu',

  // Letter explanation

  'letter.explain.title',

  'letter.explain.about',

  'letter.explain.importance',

  'letter.explain.deadline',

  'letter.explain.nextSteps',

  'letter.explain.disclaimerTitle',

  'letter.explain.about.bgBau',

  'letter.explain.deadline.recognized',

  'letter.explain.importance.high',

  'letter.explain.uncertainHint',

  // Document errors

  'documentExplanation.noData',

] as const;



export type CoreI18nPath = (typeof CORE_I18N_PATHS)[number];

