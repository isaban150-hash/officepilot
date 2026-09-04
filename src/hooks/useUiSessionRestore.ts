import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { UiSessionSnapshot } from '../types/uiSessionSnapshot';
import { applyMainScrollTop } from '../services/uiSession/uiSessionCapture';
import { takePendingUiSessionApply } from '../services/uiSession/uiSessionLiveState';
import { buildUiSessionRouteKey } from '../services/uiSession/uiSessionRoute';

/**
 * Consume pending silent/continue restore for the current route once.
 * Initial state reads synchronously so page useState can hydrate chrome.
 */
export interface UiSessionRestoreOptions {
  /**
   * MOBILE-RESUME-STATE-02B — die Scrollposition **nicht** hier anwenden.
   *
   * Formularseiten mit bedingten Bereichen brauchen eine Reihenfolge: Erst muss
   * der wiederhergestellte Formzustand gerendert sein, sonst wird die alte
   * Scrollposition auf eine kürzere Seite angewandt und auf deren Ende geklemmt
   * — genau der Sprung, über den sich Nutzer beschweren.
   *
   * Wer dies setzt, übernimmt die Anwendung selbst (siehe `useFormResume`).
   * Ohne die Option verhält sich der Hook unverändert.
   */
  deferScroll?: boolean;
}

export function useUiSessionRestore(
  options: UiSessionRestoreOptions = {},
): UiSessionSnapshot | null {
  const location = useLocation();
  /*
   * GLOBAL-WORKSPACE-CONTINUITY-01B — derselbe Arbeitsplatzschlüssel wie im
   * Speicher: Navigationsparameter wie `vtab` oder `step` trennen keine
   * Arbeitsplätze.
   */
  const routeKey = buildUiSessionRouteKey(location.pathname, location.search);
  const [snapshot, setSnapshot] = useState(() => takePendingUiSessionApply(routeKey));
  const deferScroll = options.deferScroll === true;

  /*
   * Der Wiederaufnahme-Host entscheidet jetzt auch bei Navigation neu. Bleibt
   * die Seite dabei montiert — etwa Vorgang A → Vorgang B über dieselbe Route —,
   * muss sie den neuen Schnappschuss abholen; sonst arbeitete B mit A's Stand.
   */
  useEffect(() => {
    const next = takePendingUiSessionApply(routeKey);
    if (next) setSnapshot(next);
  }, [routeKey]);

  useEffect(() => {
    if (!snapshot || deferScroll) return;
    applyMainScrollTop(snapshot.scroll.mainTop);
  }, [snapshot, deferScroll]);

  return snapshot;
}
