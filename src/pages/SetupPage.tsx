import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FirstRunWizard } from '../components/setup/FirstRunWizard';
import { useApp } from '../context/AppContext';
import { getInvoiceNumberSequenceSnapshot } from '../services/invoiceNumberService';
import { createDefaultSetupWizardDraft } from '../types/setup';

export function SetupPage() {
  const { setup, companyProfile, completeSetupWizard, translate, showToast } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    if (setup.setupComplete) {
      navigate('/', { replace: true });
    }
  }, [setup.setupComplete, navigate]);

  if (setup.setupComplete) {
    return null;
  }

  const initialDraft = createDefaultSetupWizardDraft(
    setup,
    companyProfile,
    getInvoiceNumberSequenceSnapshot().lastIssuedNumber,
  );

  return (
    <FirstRunWizard
      initialDraft={initialDraft}
      onComplete={(draft) => {
        const result = completeSetupWizard(draft);
        if (result.success) {
          showToast(translate('setup.completed'));
          navigate('/', { replace: true });
        }
        return result;
      }}
    />
  );
}
