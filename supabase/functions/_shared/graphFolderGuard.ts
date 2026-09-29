/**
 * E-MAIL-07E-MSA-FIX1 — Systemordner-Schutz für delegierte Microsoft-Postfächer.
 *
 * Ziel: Ein persönliches Postfach mit vielen alten privaten Mails darf nur aus
 * dem bewusst angelegten Testordner gelesen werden. Ein Microsoft-Systemordner
 * (Posteingang, Gesendet, Entwürfe, Gelöscht, Junk, Archiv, …) darf technisch
 * nie Importquelle werden — auch nicht über einen umbenannten Anzeigenamen
 * oder eine nachträglich veränderte Ordner-ID. Kein Rückfall, kein stilles
 * Umschalten: Im Zweifel wird NICHT gelesen.
 *
 * Stabile Kennung: Microsoft Graph löst die dokumentierten „well-known folder
 * names" (`/me/mailFolders/{name}`) auf die echte Ordner-ID auf. Diese IDs
 * sind maßgeblich; der Anzeigename wird nur ergänzend geprüft.
 *
 * Reine Logik ohne Netz; der Graph-Adapter liefert die Daten.
 */

/** Jetzt (Testphase) einzige erlaubte Importquelle für delegierte Microsoft-Verbindungen. */
export const MICROSOFT_ALLOWED_SOURCE_FOLDERS: readonly string[] = ['OfficeTakt-Test'];

/**
 * Dokumentierte Graph-„well-known folder names" (mailFolder). Alle werden vor
 * jedem Abruf auf ihre echte ID aufgelöst; keiner darf Importquelle sein.
 * `msgfolderroot` und `inbox` müssen auflösbar sein (erlaubte Eltern des
 * Testordners), sonst wird aus Sicherheitsgründen nicht gelesen.
 */
export const GRAPH_WELL_KNOWN_FOLDERS = [
  'msgfolderroot',
  'inbox',
  'sentitems',
  'drafts',
  'deleteditems',
  'junkemail',
  'archive',
  'outbox',
  'conversationhistory',
  'scheduled',
  'clutter',
  'recoverableitemsdeletions',
  'searchfolders',
  'syncissues',
  'conflicts',
  'localfailures',
  'serverfailures',
] as const;
export type GraphWellKnownFolder = (typeof GRAPH_WELL_KNOWN_FOLDERS)[number];
export const GRAPH_REQUIRED_WELL_KNOWN: readonly GraphWellKnownFolder[] = ['msgfolderroot', 'inbox'];

/**
 * Ergänzend: sichtbare Namen von Systemordnern (Englisch/Deutsch, gängige
 * Varianten). Vergleich ohne Groß-/Kleinschreibung, Leerzeichen, Binde- und
 * Unterstriche.
 */
const SYSTEM_FOLDER_NAMES = [
  'inbox', 'posteingang',
  'sent', 'sentitems', 'sentmail', 'gesendet', 'gesendeteelemente', 'gesendeteobjekte',
  'drafts', 'draft', 'entwurf', 'entwürfe', 'entwuerfe',
  'deleted', 'deleteditems', 'trash', 'bin', 'papierkorb', 'gelöscht', 'geloescht', 'gelöschteelemente', 'geloeschteelemente', 'gelöschteobjekte',
  'junk', 'junkemail', 'junkmail', 'junke-mail', 'spam', 'werbung',
  'archive', 'archiv',
  'outbox', 'postausgang',
  'conversationhistory', 'unterhaltungsverlauf',
  'scheduled', 'geplant',
  'clutter', 'nebensächlich',
  'syncissues', 'synchronisierungsprobleme', 'conflicts', 'konflikte', 'localfailures', 'lokalefehler', 'serverfailures', 'serverfehler',
  'msgfolderroot', 'topofinformationstore', 'rootfolder',
  'searchfolders', 'suchordner', 'recoverableitemsdeletions',
];
const SYSTEM_NAME_SET = new Set(SYSTEM_FOLDER_NAMES.map((name) => normalizeFolderName(name)));

export function normalizeFolderName(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/[\s_\-]+/g, '').trim();
}

export function isSystemFolderName(name: string): boolean {
  return SYSTEM_NAME_SET.has(normalizeFolderName(name));
}

export type FolderGuardCode =
  | 'graph_folder_missing'
  | 'graph_folder_not_allowed'
  | 'graph_folder_system'
  | 'graph_folder_not_found'
  | 'graph_folder_ambiguous'
  | 'graph_folder_changed'
  | 'graph_folder_moved'
  | 'graph_folder_unverifiable';

/** Nur ein erlaubter Name, nie ein Systemordnername. `allowed = null` = später frei wählbar (Firmenkunden). */
export function checkSourceFolderName(name: string | null | undefined, allowed: readonly string[] | null = MICROSOFT_ALLOWED_SOURCE_FOLDERS): FolderGuardCode | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'graph_folder_missing';
  if (isSystemFolderName(trimmed)) return 'graph_folder_system';
  if (allowed && !allowed.some((entry) => normalizeFolderName(entry) === normalizeFolderName(trimmed))) return 'graph_folder_not_allowed';
  return null;
}

export interface GraphFolderInfo {
  id: string;
  displayName: string;
  parentFolderId: string | null;
}

/**
 * Ist dieser konkrete Ordner als Importquelle zulässig?
 *   * nie ein well-known Systemordner (per ID, unabhängig vom Anzeigenamen),
 *   * Anzeigename entspricht weiterhin dem erwarteten Namen (sonst wurde die
 *     gespeicherte ID umgebogen bzw. der Ordner umbenannt → stoppen),
 *   * liegt direkt unter der Postfach-Wurzel oder direkt im Posteingang
 *     (verschoben, z. B. in „Gelöschte Elemente" → stoppen),
 *   * und ist auch dem Namen nach kein Systemordner.
 */
export function evaluateSourceFolder(
  folder: GraphFolderInfo,
  context: { expectedName: string; wellKnownIds: ReadonlyMap<string, string> },
): FolderGuardCode | null {
  const rootId = context.wellKnownIds.get('msgfolderroot');
  const inboxId = context.wellKnownIds.get('inbox');
  if (!rootId || !inboxId) return 'graph_folder_unverifiable';
  const systemIds = new Set([...context.wellKnownIds.values()].map((id) => id.toLowerCase()));
  if (systemIds.has(folder.id.toLowerCase())) return 'graph_folder_system';
  if (isSystemFolderName(folder.displayName)) return 'graph_folder_system';
  if (normalizeFolderName(folder.displayName) !== normalizeFolderName(context.expectedName)) return 'graph_folder_changed';
  const parent = (folder.parentFolderId ?? '').toLowerCase();
  if (parent !== rootId.toLowerCase() && parent !== inboxId.toLowerCase()) return 'graph_folder_moved';
  return null;
}
