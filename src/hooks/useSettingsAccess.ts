import { useEffect, useState } from 'react';
import { isSupabaseConfigured } from '../lib/supabase';
import { useWorkspaceWriteAccess } from './useWorkspaceWriteAccess';
import {
  resolveCloudConfirmedActionAccess,
  type WorkspaceWriteAccess,
} from '../services/workspace/workspaceRoleService';
import type { SettingsHubViewer } from '../pages/settings/settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.16) — was eine Einstellungsseite dem angemeldeten Konto anbietet.
 *
 * Eine Auskunft für Hub und Unterseiten, reaktiv wie `useWorkspaceWriteAccess`: Rolle, Betriebslizenz,
 * Löschantrag und unbestätigte Rechte wirken sofort, ohne Neuladen. Der Server prüft jede Aktion selbst.
 *
 * - `canEdit`: Schreibfelder und Speicherleiste — nur Inhaber und Admins (bzw. der lokale Betrieb) mit wirksamer Lizenz
 *   und ohne Löschantrag.
 * - `canConfirmedAction`: cloudbestätigte Aktionen (Team, Nummernkreise, Löschung, Export mit Abgleich) — zusätzlich
 *   bestätigte Rechte und eine Verbindung (1.11).
 * - `managesWorkspace`: die Rolle erlaubt Betriebsziele (Inhaber, Admin, lokaler Betrieb), unabhängig von Lizenz und
 *   Löschantrag. Maßgeblich für Sicherung und Export (E9) und die Sichtbarkeit im Hub.
 */
export interface SettingsAccess {
  access: WorkspaceWriteAccess;
  cloud: boolean;
  online: boolean;
  viewer: SettingsHubViewer;
  canEdit: boolean;
  canConfirmedAction: boolean;
  managesWorkspace: boolean;
  isOwner: boolean;
}

function readOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(readOnline);
  useEffect(() => {
    const update = () => setOnline(readOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function resolveSettingsAccess(access: WorkspaceWriteAccess, cloud: boolean, online: boolean): SettingsAccess {
  const localOnly = access.reason === 'local_only';
  const role = localOnly ? null : access.role;
  const managesWorkspace = localOnly || role === 'owner' || role === 'admin';
  return {
    access,
    cloud,
    online,
    viewer: { cloud: cloud && !localOnly, role },
    canEdit: access.canWrite,
    canConfirmedAction: !localOnly && resolveCloudConfirmedActionAccess(access) && online,
    managesWorkspace,
    isOwner: role === 'owner',
  };
}

export function useSettingsAccess(): SettingsAccess {
  const access = useWorkspaceWriteAccess();
  const online = useOnlineStatus();
  return resolveSettingsAccess(access, isSupabaseConfigured(), online);
}
