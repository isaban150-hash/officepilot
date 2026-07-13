import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CompanySetup } from '../../types/models';
import { useAuth } from '../../context/AuthContext';
import { AppProvider } from '../../context/AppContext';
import { bootstrapBusinessState, isolateBusinessStateOnLogout } from '../../services/storage/storageBootstrapService';
import {
  bootstrapWorkspaceCloudSyncIfNeeded,
  resetWorkspaceCloudBootstrapForTests,
} from '../../services/workspace/workspaceCloudBootstrapService';
import { resetCompanySession } from '../../services/brain/companySessionService';
import { isSupabaseConfigured } from '../../lib/supabase';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';

function BootstrapLoading() {
  const lang = getCachedSetup()?.language ?? 'de';
  return (
    <div className="bootstrap-loading" data-testid="bootstrap-loading">
      <p className="bootstrap-loading__text">{t('common.loading.app', lang)}</p>
    </div>
  );
}

interface BusinessStateGateProps {
  children: ReactNode;
}

export function BusinessStateGate({ children }: BusinessStateGateProps) {
  const { user, isAuthReady, isAuthenticated, isAllowed } = useAuth();
  const [setup, setSetup] = useState<CompanySetup | null>(null);
  const [bootstrapKey, setBootstrapKey] = useState('guest');
  const bootstrappedUserRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isAuthReady) return;

    const nextUserId = user?.id ?? null;

    if (bootstrappedUserRef.current === nextUserId) {
      return;
    }

    if (bootstrappedUserRef.current && !nextUserId) {
      isolateBusinessStateOnLogout();
      resetCompanySession();
      resetWorkspaceCloudBootstrapForTests();
      const guestResult = bootstrapBusinessState();
      setSetup(guestResult.setup);
      setBootstrapKey('guest');
      bootstrappedUserRef.current = null;
      return;
    }

    bootstrappedUserRef.current = nextUserId;
    const result = bootstrapBusinessState(nextUserId ? { userId: nextUserId } : {});
    setSetup(result.setup);
    setBootstrapKey(nextUserId ?? 'guest');

    if (nextUserId && isAuthenticated && isAllowed && isSupabaseConfigured()) {
      void bootstrapWorkspaceCloudSyncIfNeeded().then(() => {
        const workspaceId = getWorkspaceStoreSnapshot()?.id;
        setSetup(getCachedSetup());
        setBootstrapKey(workspaceId ? `${nextUserId}:${workspaceId}` : (nextUserId ?? 'guest'));
      });
    }
  }, [isAuthReady, isAuthenticated, isAllowed, user?.id]);

  if (!isAuthReady || !setup) {
    return <BootstrapLoading />;
  }

  return (
    <AppProvider key={bootstrapKey} initialSetup={setup}>
      {children}
    </AppProvider>
  );
}
