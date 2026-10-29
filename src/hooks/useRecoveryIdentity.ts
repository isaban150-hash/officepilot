import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseClient } from '../lib/supabase';
import {
  confirmRecoveryIdentity,
  legacyWorkspaceIdsOf,
  signInForRecovery,
  signOutFromRecovery,
  type RecoveryIdentity,
} from '../services/storage/localRecoveryAccessService';

export type RecoveryLoginError = 'failed' | 'offline' | null;

/**
 * EINRICHTUNG-01 (AP1, E8) — die bestätigte Identität auf den Notfallseiten.
 *
 * Beim Öffnen, nach dem Anmelden und vor jeder Sicherung eines gebundenen Bestands wird beim Server bestätigt.
 * Eine spätere Prüfung hat Vorrang: Eine verspätete Antwort setzt nichts mehr (Abmelden während einer Prüfung).
 */
export function useRecoveryIdentity(storageKeys: readonly string[]) {
  const legacyWorkspaceIds = useMemo(() => legacyWorkspaceIdsOf(storageKeys), [storageKeys]);
  const [identity, setIdentity] = useState<RecoveryIdentity>({ state: 'checking' });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<RecoveryLoginError>(null);
  const generation = useRef(0);

  const confirm = useCallback(async (): Promise<RecoveryIdentity> => {
    const mine = ++generation.current;
    const next = await confirmRecoveryIdentity(getSupabaseClient(), legacyWorkspaceIds);
    if (mine === generation.current) setIdentity(next);
    return mine === generation.current ? next : { state: 'checking' };
  }, [legacyWorkspaceIds]);

  useEffect(() => {
    void confirm();
    return () => {
      generation.current += 1;
    };
  }, [confirm]);

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      if (loginBusy) return false;
      setLoginBusy(true);
      setLoginError(null);
      try {
        const result = await signInForRecovery(getSupabaseClient(), email, password);
        if (result !== 'ok') {
          setLoginError(result === 'offline' ? 'offline' : 'failed');
          return false;
        }
        const next = await confirm();
        return next.state === 'confirmed';
      } finally {
        setLoginBusy(false);
      }
    },
    [confirm, loginBusy],
  );

  const logout = useCallback(async () => {
    generation.current += 1;
    setIdentity({ state: 'checking' });
    await signOutFromRecovery(getSupabaseClient());
    await confirm();
  }, [confirm]);

  return { identity, confirm, login, logout, loginBusy, loginError };
}
