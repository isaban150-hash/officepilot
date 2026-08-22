import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FirstRunWizard } from '../components/setup/FirstRunWizard';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { useApp } from '../context/AppContext';
import { getInvoiceNumberSequenceSnapshot } from '../services/invoiceNumberService';
import { createDefaultSetupWizardDraft } from '../types/setup';
import { syncCompanyDataAfterSetup } from '../services/sync/syncUiService';

export function SetupPage() {
  const { setup, companyProfile, completeSetupWizard, translate, showToast } = useApp();
  const { logout } = useAuth();
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
    <>
      {/**
       * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B — auf einer neuen Adresse oder einem
       * neuen Gerät landet auch ein Bestandskunde hier. Der Anmeldeweg steht
       * deshalb vor dem Formular; nur eine bewusste Entscheidung legt einen
       * zweiten Betrieb an. Das Öffnen dieser Seite speichert nichts.
       */}
      <section className="setup-existing-customer" data-testid="setup-existing-customer">
        <h2 className="setup-existing-customer__title">
          {translate('setup.existingCustomer.title')}
        </h2>
        <p className="setup-existing-customer__hint">
          {translate('setup.existingCustomer.hint')}
        </p>
        <Button
          type="button"
          variant="ghost"
          fullWidth
          data-testid="setup-switch-account"
          onClick={() => {
            // Erst abmelden — sonst fängt SetupRoutes den Sprung auf /login ab.
            void logout().then(() => navigate('/login', { replace: true }));
          }}
        >
          {translate('setup.existingCustomer.switchAccount')}
        </Button>
      </section>
      <FirstRunWizard
        initialDraft={initialDraft}
        onComplete={(draft) => {
          const result = completeSetupWizard(draft);
          if (result.success) {
            /**
             * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — lokal ist gespeichert (sonst
             * wäre result nicht erfolgreich). Erst jetzt einmalig in die Cloud
             * sichern; ein Cloud-Fehler rollt nichts zurück und hält den Nutzer
             * nicht auf — der Hinweis „noch nicht gesichert“ bleibt sichtbar.
             */
            void syncCompanyDataAfterSetup();
            showToast(translate('setup.completed'));
            navigate('/', { replace: true });
          }
          return result;
        }}
      />
    </>
  );
}
