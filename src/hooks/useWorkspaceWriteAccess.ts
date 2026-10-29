import { useSyncExternalStore } from 'react';
import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  resolveWorkspaceWriteAccess,
  type WorkspaceWriteAccess,
} from '../services/workspace/workspaceRoleService';
import {
  getWorkspaceAccessVersion,
  subscribeWorkspaceAccess,
} from '../services/workspace/workspaceAccessService';
import { getCloudRightsStateVersion, subscribeCloudRightsState } from '../services/auth/cloudRightsState';

function subscribe(listener: () => void): () => void {
  const a = subscribeWorkspaceAccess(listener);
  const b = subscribeCloudRightsState(listener);
  return () => {
    a();
    b();
  };
}

function snapshot(): string {
  return `${getWorkspaceAccessVersion()}:${getCloudRightsStateVersion()}`;
}

/**
 * GO-LIVE-SECURITY-01 / ABSCHLUSS — die Rollenauskunft des angemeldeten Nutzers für
 * Bausteine, die eine verbindliche Aktion anbieten (etwa „Zahlung erfassen“ in einer
 * Rechnungskarte). Dieselbe Auskunft wie auf den Detailseiten: Inhaber, Verwaltung und
 * der lokale Betrieb dürfen schreiben; Mitglieder und eine ungeklärte Rolle nicht.
 * Der Server bleibt autoritativ.
 *
 * EINRICHTUNG-01 (AP1, Vertrag 1.3; AP2, Vertrag 1.11) — meldet der Server die
 * Betriebslizenz als nicht wirksam oder läuft die App auf unbestätigten Rechten, folgt
 * die Auskunft sofort, ohne Neuladen der Seite.
 */
export function useWorkspaceWriteAccess(): WorkspaceWriteAccess {
  const user = useOptionalAuth()?.user;
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() });
}
