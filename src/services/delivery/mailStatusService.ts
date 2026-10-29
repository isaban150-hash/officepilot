import { useEffect, useState } from 'react';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-06) — Testmodus des Versandservers für Hinweise auf der Kommunikationsseite und in
 * jedem Versanddialog. Quelle ist die Edge Function `mail-status` (nur Modus, keine Adressen). Ohne Antwort
 * (`null`) zeigt die App keinen Hinweis — sie behauptet nie einen Modus, den der Server nicht gemeldet hat.
 *
 * Je Betrieb einmal je Sitzung gefragt; ein Fehlschlag wird nicht zwischengespeichert. Der Aufruf geht über den
 * Funktionsweg des Supabase-Clients (Anmeldung der Sitzung); ein Client ohne diesen Weg liefert keinen Hinweis.
 */
export type MailStatusMode = 'live' | 'stub' | 'test_recipients' | 'misconfigured';

const cache = new Map<string, MailStatusMode>();

export function resetMailStatusForTests(): void {
  cache.clear();
}

function workspaceId(): string {
  try {
    return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    return '';
  }
}

export async function loadMailStatus(): Promise<MailStatusMode | null> {
  if (!isSupabaseConfigured()) return null;
  const client = getSupabaseClient();
  const ws = workspaceId();
  const invoke = client?.functions?.invoke;
  if (!client || !ws || typeof invoke !== 'function') return null;
  const cached = cache.get(ws);
  if (cached) return cached;
  try {
    // Ohne Anmeldung weist der Server ab (401) — dann gibt es keinen Hinweis.
    const { data, error } = await client.functions.invoke('mail-status', { body: { workspaceId: ws } });
    const body = (error ? null : data) as { ok?: boolean; mode?: string } | null;
    if (body?.ok !== true) return null;
    const mode = body.mode;
    if (mode !== 'live' && mode !== 'stub' && mode !== 'test_recipients' && mode !== 'misconfigured') return null;
    cache.set(ws, mode);
    return mode;
  } catch {
    return null;
  }
}

export function useMailStatus(): MailStatusMode | null {
  const [mode, setMode] = useState<MailStatusMode | null>(null);
  useEffect(() => {
    let active = true;
    void loadMailStatus().then((value) => {
      if (active) setMode(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return mode;
}
