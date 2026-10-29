import type { CommunicationChannel } from './communication';
import type {
  AppLanguage,
  CompanyProfile,
  CompanySetup,
  MaterialStandard,
  TaxStatus,
} from './models';

export const SETUP_VERSION = 1;

export type SetupWizardStep =
  | 'company'
  | 'tax'
  | 'bank'
  | 'invoicing'
  | 'communication';

export const SETUP_WIZARD_STEPS: SetupWizardStep[] = [
  'company',
  'tax',
  'bank',
  'invoicing',
  'communication',
];

export interface SetupWizardDraft {
  language: AppLanguage;
  industry: string;
  taxStatus: TaxStatus;
  materialStandard: MaterialStandard;
  communicationChannel: CommunicationChannel;
  companyName: string;
  /** EINRICHTUNG-01 (AP3, O-02.2) — optional; landet im Firmenprofil. */
  legalForm?: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  taxNumber: string;
  vatId: string;
  bankName: string;
  iban: string;
  bic: string;
  defaultPaymentDays: number;
  defaultPaymentTerms: string;
  lastInvoiceNumber: number;
}

export function createDefaultSetupWizardDraft(
  setup: CompanySetup = {
    companyName: '',
    industry: '',
    taxStatus: 'standard_19',
    materialStandard: 'betrieb',
    language: 'de',
    setupComplete: false,
    setupVersion: 0,
    communicationChannel: 'email',
  },
  profile?: Partial<CompanyProfile>,
  lastInvoiceNumber = 0,
): SetupWizardDraft {
  return {
    language: setup.language,
    industry: setup.industry || 'Handwerk',
    taxStatus: setup.taxStatus,
    materialStandard: setup.materialStandard,
    // EINRICHTUNG-01 (AP3, O-04.2) — WhatsApp wird nicht mehr angeboten; ein Altwert beginnt mit E-Mail.
    communicationChannel:
      setup.communicationChannel && setup.communicationChannel !== 'whatsapp' ? setup.communicationChannel : 'email',
    companyName: profile?.companyName ?? setup.companyName ?? '',
    legalForm: profile?.legalForm ?? '',
    contactPerson: profile?.contactPerson ?? '',
    street: profile?.street ?? '',
    zip: profile?.zip ?? '',
    city: profile?.city ?? '',
    country: profile?.country ?? 'Deutschland',
    email: profile?.email ?? '',
    phone: profile?.phone ?? '',
    taxNumber: profile?.taxNumber ?? '',
    vatId: profile?.vatId ?? '',
    bankName: profile?.bankName ?? '',
    iban: profile?.iban ?? '',
    bic: profile?.bic ?? '',
    defaultPaymentDays: profile?.defaultPaymentDays ?? 14,
    defaultPaymentTerms:
      profile?.defaultPaymentTerms ?? 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    lastInvoiceNumber,
  };
}
