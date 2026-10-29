import type { WorkspaceWriteAccess } from './workspace/workspaceRoleService';

/**
 * EINRICHTUNG-01 (AP3; EIN-13, O-05.1, O-05.4) — wer den Einrichtungsassistenten bedienen darf.
 *
 * Im lokalen Betrieb das Gerät. Im Cloud-Betrieb nur, wer `company_setup`, `company_profile` und den Nummernkreis auch
 * auf dem Server schreiben darf: Inhaber und Admins mit wirksamer Betriebslizenz. Bisher bot die Sperrfläche „kein
 * abgeschlossener Betrieb“ jedem „Einrichtung fortsetzen“ an; ein Mitglied schloss dann lokal ab, der Server wies
 * endgültig ab, und der lokale Firmenstand wich dauerhaft ab.
 *
 * Ein Mitglied erfährt stattdessen, dass der Inhaber den Betrieb einrichtet. Eine unbekannte oder noch nicht geladene
 * Rolle sperrt (fail-closed) — kein Rückfall auf den Inhaber laut Betriebszeile oder auf den lokalen Betrieb.
 */
export type SetupWizardAccess = 'allowed' | 'member' | 'license_read_only' | 'unknown';

export function resolveSetupWizardAccess(access: WorkspaceWriteAccess): SetupWizardAccess {
  if (access.reason === 'local_only') return 'allowed';
  if (access.canWrite) return 'allowed';
  if (access.licenseReadOnly) return 'license_read_only';
  if (access.reason === 'member') return 'member';
  return 'unknown';
}
