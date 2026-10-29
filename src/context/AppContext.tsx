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
import {
  getPersonalUiLanguageOwner,
  readPersonalUiLanguage,
  storePersonalUiLanguageOnProfile,
  writePersonalUiLanguage,
} from '../services/auth/personalUiLanguage';
import type { SetupWizardDraft } from '../types/setup';
import type { SetupCompletionResult } from '../services/setupCompletionService';

interface AppContextValue {
  setup: CompanySetup;
  companyProfile: CompanyProfile;
  updateSetup: (partial: Partial<CompanySetup>) => void;
  /** EINRICHTUNG-01 (E6) — Oberflächensprache: im Cloud-Betrieb je Person, sonst über das Setup. */
  updateLanguage: (language: AppLanguage) => void;
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
  // EINRICHTUNG-01 (E6, S-15.3) — die Sprachwahl dieser Person auf diesem Gerät (nur im Cloud-Betrieb).
  const [personalLanguage, setPersonalLanguage] = useState<AppLanguage | null>(() => readPersonalUiLanguage());

  /*
   * EINRICHTUNG-01 (EIN-15, S-15) — Grundlage ist das gespeicherte Setup, nicht der React-Zustand.
   * `updateCompanyProfile` führt den Spiegel (Firmenname, Steuerstatus) im gespeicherten Setup nach;
   * der React-Zustand blieb dabei auf dem Stand vom Start. Ein Sprachwechsel danach schrieb den
   * alten Namen und Steuerstatus zurück und synchronisierte ihn als `company_setup`.
   */
  const updateSetup = useCallback((partial: Partial<CompanySetup>) => {
    const next = { ...getCachedSetup(), ...partial };
    setCachedSetup(next);
    persistAll(next);
    setSetup(getCachedSetup());
  }, []);

  /*
   * EINRICHTUNG-01 (E6, S-15.3) — im Cloud-Betrieb gehört die Oberflächensprache der Person: kein
   * `company_setup`-Auftrag, keine Firmenmutation, auch nicht für Mitglieder oder im Nur-Lesen-Betrieb.
   * Lässt sich die Wahl nicht auf dem Gerät merken, gilt sie bis zum Neuladen — das Setup des
   * Betriebs bleibt trotzdem unberührt. Im lokalen Betrieb bleibt es beim Setup.
   */
  const updateLanguage = useCallback(
    (language: AppLanguage) => {
      if (getPersonalUiLanguageOwner()) {
        writePersonalUiLanguage(language);
        setPersonalLanguage(language);
        // EINRICHTUNG-01 (AP3, K-04.3) — auch am Profil, damit die Wahl auf anderen Geräten gilt.
        void storePersonalUiLanguageOnProfile(language);
        return;
      }
      updateSetup({ language });
    },
    [updateSetup],
  );

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
      // EIN-15 — der nachgeführte Spiegel gilt auch im React-Zustand.
      setSetup(getCachedSetup());
    }
    return result;
  }, []);

  const completeSetup = useCallback(() => {
    // EIN-15 — wie `updateSetup`: auf dem gespeicherten Setup aufbauen.
    const current = getCachedSetup();
    const next = { ...current, setupComplete: true, setupVersion: current.setupVersion || 1 };
    setCachedSetup(next);
    persistAll(next);
    setSetup(getCachedSetup());
  }, []);

  const completeSetupWizardState = useCallback((draft: SetupWizardDraft): SetupCompletionResult => {
    // EINRICHTUNG-01 (AP3, EIN-14) — im Cloud-Betrieb bleibt die Sprache des Betriebs; die Wahl gehört der Person.
    const result = applySetupWizard(draft, getCachedSetup(), { keepSetupLanguage: Boolean(getPersonalUiLanguageOwner()) });
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

  /*
   * EINRICHTUNG-01 (E6) — die wirksame Oberflächensprache: die eigene Wahl, sonst die des Betriebs.
   * Leser von `setup.language` (Datums- und Statusformate) folgen ihr über die Ansicht `viewSetup`;
   * gespeichert und synchronisiert wird weiterhin nur das unveränderte Setup.
   */
  const language: AppLanguage = personalLanguage ?? setup.language;
  // EINRICHTUNG-01 (AP3, K-04.3; EIN-28) — die Seitensprache folgt der wirksamen Oberflächensprache.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }, [language]);
  const viewSetup = useMemo(
    () => (language === setup.language ? setup : { ...setup, language }),
    [setup, language],
  );

  const translate = useCallback(
    (key: TranslationKey) => t(key, language),
    [language],
  );

  const value = useMemo(
    () => ({
      setup: viewSetup,
      companyProfile,
      updateSetup,
      updateLanguage,
      updateCompanyProfile: updateCompanyProfileState,
      completeSetup,
      completeSetupWizard: completeSetupWizardState,
      resetDemo,
      translate,
      language,
      toast,
      showToast,
      clearToast,
    }),
    [
      viewSetup,
      language,
      companyProfile,
      updateSetup,
      updateLanguage,
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

/** EINRICHTUNG-01 (AP5) — für Flächen, die auch ohne AppProvider erscheinen (Rechtsseiten). */
export function useOptionalApp(): AppContextValue | null {
  return useContext(AppContext);
}

export function getInitialSetupFromCache(): CompanySetup {
  return getCachedSetup();
}
