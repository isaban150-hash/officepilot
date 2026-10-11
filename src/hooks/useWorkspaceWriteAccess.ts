import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  resolveWorkspaceWriteAccess,
  type WorkspaceWriteAccess,
} from '../services/workspace/workspaceRoleService';

/**
 * GO-LIVE-SECURITY-01 / ABSCHLUSS — die Rollenauskunft des angemeldeten Nutzers für
 * Bausteine, die eine verbindliche Aktion anbieten (etwa „Zahlung erfassen“ in einer
 * Rechnungskarte). Dieselbe Auskunft wie auf den Detailseiten: Inhaber, Verwaltung und
 * der lokale Betrieb dürfen schreiben; Mitglieder und eine ungeklärte Rolle nicht.
 * Der Server bleibt autoritativ.
 */
export function useWorkspaceWriteAccess(): WorkspaceWriteAccess {
  const user = useOptionalAuth()?.user;
  return resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() });
}
