import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { getCompanyProfile, hydrateCompanyProfileStore } from './companyProfileService';
import {
  getInvoiceNumberSequenceSnapshot,
  hydrateInvoiceNumberSequence,
  resetInvoiceNumberSequence,
} from './invoiceNumberService';
import { loadPersistedState } from './persistenceService';
import { completeSetupWizard } from './setupCompletionService';
import { validateSetupStep, validateSetupWizard } from './setupValidationService';
import { SETUP_VERSION, createDefaultSetupWizardDraft } from '../types/setup';
import { resetKnowledgeStore } from './knowledgeStore';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';

function validDraft() {
  return createDefaultSetupWizardDraft(DEFAULT_SETUP, {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Muster GmbH',
    contactPerson: 'Max Mustermann',
    street: 'Hauptstraße 1',
    zip: '80331',
    city: 'München',
    email: 'info@muster.de',
    taxNumber: '123/456/78901',
    iban: 'DE89370400440532013000',
    defaultPaymentDays: 14,
    defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  }, 42);
}

describe('setupValidationService', () => {
  it('requires company fields on company step', () => {
    const draft = createDefaultSetupWizardDraft();
    const result = validateSetupStep('company', draft);
    expect(result.valid).toBe(false);
    expect(result.errors.companyName).toBeTruthy();
    expect(result.errors.email).toBeTruthy();
  });

  it('requires tax number or vat id', () => {
    const draft = validDraft();
    draft.taxNumber = '';
    draft.vatId = '';
    expect(validateSetupStep('tax', draft).valid).toBe(false);
    draft.vatId = 'DE123456789';
    expect(validateSetupStep('tax', draft).valid).toBe(true);
  });

  it('validates IBAN on bank step', () => {
    const draft = validDraft();
    draft.iban = '';
    expect(validateSetupStep('bank', draft).valid).toBe(false);
    draft.iban = 'DE89370400440532013000';
    expect(validateSetupStep('bank', draft).valid).toBe(true);
  });

  it('validates full wizard draft', () => {
    expect(validateSetupWizard(validDraft()).valid).toBe(true);
  });
});

describe('setupCompletionService', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
    resetInvoiceNumberSequence();
    resetCommunicationHistoryStore();
    resetKnowledgeStore();
  });

  it('persists profile, setup and invoice sequence', () => {
    const result = completeSetupWizard(validDraft(), DEFAULT_SETUP);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.setup.setupComplete).toBe(true);
    expect(result.setup.setupVersion).toBe(SETUP_VERSION);
    expect(result.profile.companyName).toBe('Muster GmbH');
    expect(result.profile.iban).toBe('DE89370400440532013000');
    expect(getCompanyProfile().email).toBe('info@muster.de');
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(42);

    const loaded = loadPersistedState();
    expect(loaded?.setup.setupComplete).toBe(true);
    expect(loaded?.setup.setupVersion).toBe(SETUP_VERSION);
    expect(loaded?.companyProfile?.companyName).toBe('Muster GmbH');
    expect(loaded?.invoiceNumberSequence?.lastIssuedNumber).toBe(42);
  });

  it('rejects incomplete drafts', () => {
    const result = completeSetupWizard(createDefaultSetupWizardDraft(), DEFAULT_SETUP);
    expect(result.success).toBe(false);
    expect(localStorage.getItem('officepilot-state')).toBeNull();
  });

  it('loads existing profile values into draft helper', () => {
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Bestehend GmbH',
      contactPerson: 'Erika Beispiel',
      email: 'kontakt@bestehend.de',
    });
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 7 });
    const draft = createDefaultSetupWizardDraft(
      { ...DEFAULT_SETUP, companyName: 'Bestehend GmbH' },
      getCompanyProfile(),
      getInvoiceNumberSequenceSnapshot().lastIssuedNumber,
    );
    expect(draft.companyName).toBe('Bestehend GmbH');
    expect(draft.contactPerson).toBe('Erika Beispiel');
    expect(draft.lastInvoiceNumber).toBe(7);
  });
});
