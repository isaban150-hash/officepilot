import { useEffect, useRef } from 'react';
import { useOptionalAuth } from '../../context/AuthContext';
import { holdAccountSessionLock, releaseAccountSessionLock } from '../../services/storage/accountSessionLock';
import { DEVICE_REMOVAL_CHANNEL } from '../../services/storage/deviceDataService';

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.29, K6) — hält die Sitzungssperre des angemeldeten Kontos und hört auf die Nachricht
 * eines anderen Tabs, der die Daten dieses Kontos von diesem Gerät entfernt: anhalten, lokal abmelden (beendet
 * Hintergrund-Sync und Abrufe des Kontobereichs), Sperre freigeben.
 */
export function AccountSessionLockHost() {
  const auth = useOptionalAuth();
  const userId = auth?.user?.id ?? null;
  const logoutRef = useRef(auth?.logout);
  logoutRef.current = auth?.logout;

  useEffect(() => {
    if (!userId) return undefined;
    holdAccountSessionLock(userId);
    let channel: BroadcastChannel | null = null;
    try {
      channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DEVICE_REMOVAL_CHANNEL);
    } catch {
      channel = null;
    }
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; userId?: string } | null;
        if (data?.type !== 'device-data-removal' || data.userId !== userId) return;
        void Promise.resolve(logoutRef.current?.()).finally(() => releaseAccountSessionLock());
      };
    }
    return () => {
      channel?.close();
      releaseAccountSessionLock();
    };
  }, [userId]);

  return null;
}
