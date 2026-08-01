import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import {
  acceptContinueWorking,
  applyUiSessionChrome,
  decideUiSessionRestore,
  discardUiSessionRestore,
} from '../../services/uiSession/uiSessionRestore';
import { setPendingUiSessionApply } from '../../services/uiSession/uiSessionLiveState';
import { useUiSessionTracker } from '../../hooks/useUiSessionTracker';
import { ContinueWorkingCard } from './ContinueWorkingCard';

type BootDecision = {
  intent: 'silent' | 'offer' | 'ignore';
  snapshot: UiSessionSnapshot | null;
};

/**
 * After Auth → Workspace → Domain (AppShell mount):
 * evaluate UiSessionSnapshot → silent | Continue Working | ignore.
 * Also runs capture tracker.
 */
export function UiSessionRecoveryHost() {
  const { user } = useAuth();
  const { translate } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const bootRef = useRef<BootDecision | null>(null);

  if (bootRef.current === null) {
    const decision = decideUiSessionRestore({
      userId: user?.id ?? null,
      currentPathname: location.pathname,
      currentSearch: location.search,
    });
    bootRef.current = {
      intent: decision.intent,
      snapshot: decision.snapshot,
    };
    // Silent: stage pending apply before child pages mount/hydrate.
    if (decision.intent === 'silent' && decision.snapshot) {
      setPendingUiSessionApply(decision.snapshot);
      applyUiSessionChrome(decision.snapshot);
    }
  }

  const [offer, setOffer] = useState<UiSessionSnapshot | null>(() =>
    bootRef.current?.intent === 'offer' ? bootRef.current.snapshot : null,
  );

  useUiSessionTracker();

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setOffer(null);
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  if (!offer) return null;

  return (
    <div className="ui-session-recovery-host" data-testid="ui-session-recovery-host">
      <ContinueWorkingCard
        snapshot={offer}
        translate={translate}
        onContinue={() => {
          const target = `${offer.route.pathname}${offer.route.search}${offer.route.hash}`;
          acceptContinueWorking(offer);
          setOffer(null);
          navigate(target);
        }}
        onDiscard={() => {
          discardUiSessionRestore();
          setOffer(null);
        }}
      />
    </div>
  );
}
