import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { UiSessionSnapshot } from '../types/uiSessionSnapshot';
import { applyMainScrollTop } from '../services/uiSession/uiSessionCapture';
import { takePendingUiSessionApply } from '../services/uiSession/uiSessionLiveState';

/**
 * Consume pending silent/continue restore for the current route once.
 * Initial state reads synchronously so page useState can hydrate chrome.
 */
export function useUiSessionRestore(): UiSessionSnapshot | null {
  const location = useLocation();
  const routeKey = `${location.pathname}${location.search}`;
  const [snapshot] = useState(() => takePendingUiSessionApply(routeKey));

  useEffect(() => {
    if (!snapshot) return;
    applyMainScrollTop(snapshot.scroll.mainTop);
  }, [snapshot]);

  return snapshot;
}
