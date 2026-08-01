import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  captureAndPersistUiSession,
  readMainScrollTop,
} from '../services/uiSession/uiSessionCapture';
import { subscribeUiSessionLive } from '../services/uiSession/uiSessionLiveState';

const SCROLL_THROTTLE_MS = 200;

/**
 * Captures UiSessionSnapshot on navigation, scroll, visibility hidden, pagehide.
 */
export function useUiSessionTracker(): void {
  const location = useLocation();
  const { user } = useAuth();
  const lastScrollFlush = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = (source: 'auto' | 'explicit' = 'auto') => {
    captureAndPersistUiSession({
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      historyKey: location.key,
      mainScrollTop: readMainScrollTop(),
      userId: user?.id ?? null,
      source,
    });
  };

  // Navigation / route change
  useEffect(() => {
    flush('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally on location identity
  }, [location.pathname, location.search, location.hash, location.key, user?.id]);

  // Live chrome patches (tab/section/drafts) from pages
  useEffect(() => {
    return subscribeUiSessionLive(() => {
      flush('auto');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, user?.id]);

  // Scroll (throttled)
  useEffect(() => {
    const main = document.querySelector('.app-shell__main');
    const target: HTMLElement | Window = main instanceof HTMLElement ? main : window;

    const onScroll = () => {
      const now = Date.now();
      if (now - lastScrollFlush.current < SCROLL_THROTTLE_MS) {
        if (scrollTimer.current) clearTimeout(scrollTimer.current);
        scrollTimer.current = setTimeout(() => {
          lastScrollFlush.current = Date.now();
          flush('auto');
        }, SCROLL_THROTTLE_MS);
        return;
      }
      lastScrollFlush.current = now;
      flush('auto');
    };

    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, user?.id]);

  // visibilitychange + pagehide
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flush('auto');
      }
    };
    const onPageHide = () => {
      flush('auto');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, user?.id]);
}
