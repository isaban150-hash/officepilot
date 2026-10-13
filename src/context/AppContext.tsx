import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppLanguage, CompanyProfile, CompanySetup } from '../types/models';
import { t, type TranslationKey } from '../i18n';
import { getCompanyProfile, updateCompanyProfile } from '../services/companyProfileService';
import { completeSetupWizard as applySetupWizard } from '../services/setupCompletionService';
import { getCachedSetup, persistAll, resetDemoData, setCachedSetup, subscribeLocalMutations } from '../services/persistenceService';
import type { SetupWizardDraft } from '../types/setup';
import type { SetupCompletionResult } from '../services/setupCompletionService';

interface AppContextValue {
  setup: CompanySetup;
  companyProfile: CompanyProfile;
  updateSetup: (partial: Partial<CompanySetup>) => void;
  updateCompanyProfile: (partial: Partial<CompanyProfile>) => CompanyProfileUpdateResult;
  completeSetup: () => void;
  completeSetupWizard: (draft: SetupWizardDraft) => SetupCompletionResult;
  resetDemo: (keepSetup?: boolean) => void;
  translate: (key: TranslationKey) => string;
  language: AppLanguage;
  toast: string | null;
  showToast: (message: string) => void;
  clearToast: () => void;
}

type CompanyProfileUpdateResult =
  | { success: true; profile: CompanyProfile }
  | { success: false; errorKey: string };

const AppContext = createContext<AppContextValue | null>(null);

/** FINANZ-CORE-01A (EIN-03) — feldweise; verschachtelte Werte (Branding) über ihren Inhalt. */
function sameCompanyProfile(a: CompanyProfile, b: CompanyProfile): boolean {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (x[key] === y[key]) continue;
    if (typeof x[key] === 'object' && typeof y[key] === 'object' && JSON.stringify(x[key]) === JSON.stringify(y[key])) continue;
    return false;
  }
  return true;
}

interface AppProviderProps {
  children: ReactNode;
  initialSetup: CompanySetup;
}

export function AppProvider({ children, initialSetup }: AppProviderProps) {
  const [setup, setSetup] = useState<CompanySetup>(initialSetup);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(() => getCompanyProfile());
  /*
   * FINANZ-CORE-01A (EIN-03) — der Kontext folgt dem Firmenprofil im Store. Bisher wurde er nur
   * nach eigenem Speichern aktualisiert: Ein Abzug aus der Cloud (ein anderes Gerät änderte etwa
   * die IBAN) landete im Store, Kontext und Einstellungsseiten zeigten weiter den Stand vom Start
   * und schrieben ihn beim nächsten Speichern zurück. Jeder Abzug speichert lokal und meldet sich
   * über `subscribeLocalMutations`; gesetzt wird nur bei echter Abweichung.
   */
  const companyProfileRef = useRef(companyProfile);
  companyProfileRef.current = companyProfile;
  useEffect(
    () =>
      subscribeLocalMutations(() => {
        const current = getCompanyProfile();
        if (!sameCompanyProfile(companyProfileRef.current, current)) setCompanyProfile(current);
      }),
    [],
  );
  const [toast, setToast] = useState<string | null>(null);

  const updateSetup = useCallback((partial: Partial<CompanySetup>) => {
    setSetup((prev) => {
      const next = { ...prev, ...partial };
      setCachedSetup(next);
      persistAll(next);
      return next;
    });
  }, []);

  const updateCompanyProfileState = useCallback((partial: Partial<CompanyProfile>) => {
    /*
     * `updateCompanyProfile` pflegt den Legacy-Spiegel `CompanySetup.companyName`
     * bereits selbst und persistiert ihn. Ein zweites Nachziehen im React-State
     * ist damit überflüssig — und wäre die einzige Stelle, die den Namen noch
     * als Setup-Wahrheit behandelt. Die aktuelle Identität kommt aus
     * `companyProfile`.
     */
    const result = updateCompanyProfile(partial);
    if (result.success) {
      setCompanyProfile(result.profile);
    }
    return result;
  }, []);

  const completeSetup = useCallback(() => {
    setSetup((prev) => {
      const next = { ...prev, setupComplete: true, setupVersion: prev.setupVersion || 1 };
      setCachedSetup(next);
      persistAll(next);
      return next;
    });
  }, []);

  const completeSetupWizardState = useCallback((draft: SetupWizardDraft): SetupCompletionResult => {
    const result = applySetupWizard(draft, getCachedSetup());
    if (result.success) {
      setSetup(result.setup);
      setCompanyProfile(result.profile);
      setCachedSetup(result.setup);
    }
    return result;
  }, []);

  const resetDemo = useCallback((keepSetup = false) => {
    const nextSetup = resetDemoData({ keepSetup });
    setSetup(nextSetup);
    window.location.reload();
  }, []);

  /*
   * FINANZ-CORE-01A — ein Timer je Meldung, der den vorigen ersetzt: Bisher löschte der
   * Timer der ersten Meldung eine zweite, die kurz danach kam, vorzeitig. Beim Abbau wird
   * er gelöscht; sonst setzte er nach dem Verlassen noch Zustand (in Tests nach dem
   * Abbau der Umgebung: „window is not defined").
   */
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 3500);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const clearToast = useCallback(() => setToast(null), []);

  const translate = useCallback(
    (key: TranslationKey) => t(key, setup.language),
    [setup.language],
  );

  const value = useMemo(
    () => ({
      setup,
      companyProfile,
      updateSetup,
      updateCompanyProfile: updateCompanyProfileState,
      completeSetup,
      completeSetupWizard: completeSetupWizardState,
      resetDemo,
      translate,
      language: setup.language,
      toast,
      showToast,
      clearToast,
    }),
    [
      setup,
      companyProfile,
      updateSetup,
      updateCompanyProfileState,
      completeSetup,
      completeSetupWizardState,
      resetDemo,
      translate,
      toast,
      showToast,
      clearToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function getInitialSetupFromCache(): CompanySetup {
  return getCachedSetup();
}
