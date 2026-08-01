import { useEffect, useRef } from 'react';
import type { UiSessionLiveChrome } from '../types/uiSessionSnapshot';
import { patchUiSessionLiveChrome } from '../services/uiSession/uiSessionLiveState';

/**
 * Pages report tab/section/panels/drafts into the live chrome used by capture.
 */
export function useReportUiSession(chrome: Partial<UiSessionLiveChrome>): void {
  const serialized = JSON.stringify(chrome);
  const last = useRef('');

  useEffect(() => {
    if (serialized === last.current) return;
    last.current = serialized;
    patchUiSessionLiveChrome(JSON.parse(serialized) as Partial<UiSessionLiveChrome>);
  }, [serialized]);
}
