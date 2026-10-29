import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FirstRunWizard, type FirstRunWizardState, type SetupCompletionTarget } from '../components/setup/FirstRunWizard';
import { TEAM_SETTINGS_ROUTE } from './settings/TeamSettingsPage';
import { Button } from '../components/ui/Button';
import { SkipLink } from '../components/system/SkipLink';
import { useAuth } from '../context/AuthContext';
import { useApp } from '../context/AppContext';
import { getInvoiceNumberSequenceSnapshot } from '../services/invoiceNumberService';
import { createDefaultSetupWizardDraft, type SetupWizardDraft } from '../types/setup';
import { syncCompanyDataAfterSetup } from '../services/sync/syncUiService';
import { validateSetupWizard } from '../services/setupValidationService';
import type { SetupCompletionResult } from '../services/setupCompletionService';
import { isSupabaseConfigured } from '../lib/supabase';
import { useWorkspaceWriteAccess } from '../hooks/useWorkspaceWriteAccess';
import { resolveSetupWizardAccess, type SetupWizardAccess } from '../services/setupAccessService';
import { getWorkspaceStoreSnapshot } from '../services/workspace/workspaceStore';
import { requestWorkspaceAccessRefresh } from '../services/workspace/workspaceAccessService';
import {
  applyRegistrationPrefill,
  clearSetupDraft,
  readSetupDraft,
  resolveSetupDraftBinding,
  writeSetupDraft,
  type SetupDraftBinding,
  type StoredSetupDraft,
} from '../services/setupDraftService';
import {
  resolveSetupNumberRangeWorkspaceId,
  startInvoiceNumberRangeForSetup,
} from '../services/setupNumberRangeService';
import type { TranslationKey } from '../i18n';

/** EINRICHTUNG-01 (AP3, O-05) — Titel und Hinweis, wenn diese Person den Assistenten nicht bedienen darf. */
const BLOCKED_TEXTS: Record<Exclude<SetupWizardAccess, 'allowed'>, { title: TranslationKey; hint: TranslationKey }> = {
  member: { title: 'setupFlow.member.title', hint: 'setupFlow.member.hint' },
  license_read_only: { title: 'setupFlow.license.title', hint: 'setupFlow.license.hint' },
  unknown: { title: 'setupFlow.unknown.title', hint: 'setupFlow.unknown.hint' },
};

interface InitialWizardState {
  binding: SetupDraftBinding;
  draft: SetupWizardDraft;
  stored: StoredSetupDraft | null;
}

export function SetupPage() {
  const { setup, companyProfile, completeSetupWizard, translate, showToast } = useApp();
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const access = useWorkspaceWriteAccess();
  /*
   * EINRICHTUNG-01 (AP3; EIN-13, O-05.1, O-05.4) — nur wer die Firmendaten auch auf dem Server schreiben darf,
   * bekommt den Assistenten. Ein Mitglied liest, dass der Inhaber einrichtet; eine unbekannte Rolle sperrt.
   */
  const wizardAccess = resolveSetupWizardAccess(access);

  /*
   * EINRICHTUNG-01 (AP3; O-01, O-02.1) — einmal beim Öffnen: ein gespeicherter Entwurf dieses Kontos und Betriebs geht
   * vor; sonst die Vorbelegung aus Firmenprofil und Registrierung (nur leere Felder).
   */
  const [initial] = useState<InitialWizardState>(() => {
    const binding = resolveSetupDraftBinding(
      isSupabaseConfigured() ? user?.id : null,
      getWorkspaceStoreSnapshot()?.id ?? null,
    );
    const stored = readSetupDraft(binding);
    if (stored) return { binding, draft: stored.draft, stored };
    const base = createDefaultSetupWizardDraft(
      setup,
      companyProfile,
      getInvoiceNumberSequenceSnapshot().lastIssuedNumber,
    );
    return {
      binding,
      stored: null,
      draft: user
        ? applyRegistrationPrefill(base, {
            companyName: user.companyName,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phone: user.phone,
            industry: user.industry,
          })
        : base,
    };
  });
  const completedRef = useRef(false);
  /*
   * EINRICHTUNG-01 (AP4, O-06.1) — „Team einladen“ gibt es nur für einen beim Server angelegten Betrieb; im lokalen
   * Betrieb gibt es kein Team.
   */
  const teamInvite = isSupabaseConfigured() && Boolean(resolveSetupNumberRangeWorkspaceId(1));

  useEffect(() => {
    if (setup.setupComplete) {
      navigate('/', { replace: true });
    }
  }, [setup.setupComplete, navigate]);

  /*
   * EINRICHTUNG-01 (AP3; Vertrag 1.3) — die Betriebslizenz beim Server erfragen: Ist sie nicht wirksam, gilt Nur-Lesen,
   * und die Einrichtung erklärt das, statt Eingaben anzunehmen, die der Server abweist.
   */
  useEffect(() => {
    if (isSupabaseConfigured()) requestWorkspaceAccessRefresh({ force: true });
  }, []);

  const handleStateChange = useCallback(
    (state: FirstRunWizardState) => {
      // Nach dem Abschluss kein Nachzügler, der den eben gelöschten Entwurf wieder anlegt.
      if (completedRef.current) return;
      writeSetupDraft(initial.binding, state);
    },
    [initial.binding],
  );

  const handleComplete = useCallback(
    (draft: SetupWizardDraft, next: SetupCompletionTarget = 'home'): SetupCompletionResult | Promise<SetupCompletionResult> => {
      const finishLocally = (): SetupCompletionResult => {
        const result = completeSetupWizard(draft);
        if (result.success) {
          // O-01 — der Entwurf hat seinen Zweck erfüllt; bei einem Fehler bleibt er stehen (O-01.3).
          completedRef.current = true;
          clearSetupDraft(initial.binding);
          /**
           * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — lokal ist gespeichert (sonst
           * wäre result nicht erfolgreich). Erst jetzt einmalig in die Cloud
           * sichern; ein Cloud-Fehler rollt nichts zurück und hält den Nutzer
           * nicht auf — der Hinweis „noch nicht gesichert“ bleibt sichtbar.
           */
          void syncCompanyDataAfterSetup();
          showToast(translate('setup.completed'));
          // EINRICHTUNG-01 (AP4, O-06.1) — „Abschließen und Team einladen“ führt direkt zur Teamseite.
          navigate(next === 'team' ? TEAM_SETTINGS_ROUTE : '/', { replace: true });
        }
        return result;
      };

      // Erst die vollständige Prüfung, dann ein Serveraufruf — ein unvollständiger Entwurf erreicht den Server nicht.
      const validation = validateSetupWizard(draft);
      if (!validation.valid) return { success: false, errors: validation.errors };

      /*
       * EINRICHTUNG-01 (AP3, O-04.3) — FINANZ-CORE-01A (RE-02): Die angegebene letzte Rechnungsnummer erreicht den
       * Server, bevor die Einrichtung als abgeschlossen gilt. Scheitert das, bleibt der Assistent stehen.
       */
      const workspaceId = resolveSetupNumberRangeWorkspaceId(draft.lastInvoiceNumber);
      if (!workspaceId) return finishLocally();
      return startInvoiceNumberRangeForSetup(workspaceId, draft.lastInvoiceNumber).then(
        (outcome): SetupCompletionResult =>
          outcome.ok ? finishLocally() : { success: false, errorKey: outcome.errorKey, retryable: true },
      );
    },
    [completeSetupWizard, initial.binding, navigate, showToast, translate],
  );

  if (setup.setupComplete) {
    return null;
  }

  // EINRICHTUNG-01 (AP9; 1.32) — erstes fokussierbares Element der Seite: Sprung zum aktuellen Schritt bzw. zum Hinweis.
  const skipLink = (
    <SkipLink
      href="#setup-progress"
      label={translate('a11y.skipToContent')}
      findTarget={() =>
        document.getElementById('setup-progress') ?? document.querySelector<HTMLElement>('[data-testid="setup-blocked"] h2')
      }
    />
  );

  const existingCustomer = (
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
    </>
  );

  if (wizardAccess !== 'allowed') {
    const texts = BLOCKED_TEXTS[wizardAccess];
    return (
      <>
        {skipLink}
        {existingCustomer}
        <section className="setup-existing-customer" data-testid="setup-blocked" data-access={wizardAccess}>
          <h2 className="setup-existing-customer__title">{translate(texts.title)}</h2>
          <p className="setup-existing-customer__hint">{translate(texts.hint)}</p>
          {wizardAccess === 'member' ? (
            <p className="setup-existing-customer__hint" data-testid="setup-member-hint">
              {translate('setupFlow.member.next')}
            </p>
          ) : null}
        </section>
      </>
    );
  }

  return (
    <>
      {skipLink}
      {existingCustomer}
      <FirstRunWizard
        initialDraft={initial.draft}
        initialStepIndex={initial.stored?.stepIndex ?? 0}
        initialNumericText={initial.stored?.numericText}
        resumed={initial.stored !== null}
        onStateChange={handleStateChange}
        onComplete={handleComplete}
        teamInvite={teamInvite}
      />
    </>
  );
}
