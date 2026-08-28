import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AppLanguage, CompanyProfile, CompanySetup } from '../types/models';
import { t, type TranslationKey } from '../i18n';
import { getCompanyProfile, updateCompanyProfile } from '../services/companyProfileService';
import { completeSetupWizard as applySetupWizard } from '../services/setupCompletionService';
import {
  getCachedSetup,
  persistAll,
  resetDemoData,
  setCachedSetup,
} from '../services/persistenceService';
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

interface AppProviderProps {
  children: ReactNode;
  initialSetup: CompanySetup;
}

export function AppProvider({ children, initialSetup }: AppProviderProps) {
  const [setup, setSetup] = useState<CompanySetup>(initialSetup);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(() => getCompanyProfile());
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

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  }, []);

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
