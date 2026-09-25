/**
 * FINANZ-SYNC-BLOCKER-01B/01F — Arbeitsbereichs-Einstellungen zusammenführen.
 *
 * Bisher endete eine Versionsabweichung in einer Sackgasse: Der Pull meldete
 * einen Konflikt und übernahm **nichts**, die Push-Schleife übergeht `blocked`,
 * das Wiederholen fasst nur `error` an. 01B hat dafür den Feldmerge gebaut.
 *
 * Die sichtbare Abnahme 01E hat zwei Lücken darin aufgedeckt, die 01F schliesst:
 *
 *   1. Der Merge lief **nur** bei ungleichen Versionsnummern. Sonst ersetzte
 *      der Pull das lokale Einstellungsobjekt vollständig durch das der Cloud —
 *      ein bewusst gesetztes, noch nicht übertragenes Feld verschwand dabei
 *      still. Genau so ging `chartOfAccounts = SKR03` verloren.
 *   2. Der offene Konflikt lag in einer Modulvariable. Ein Neuladen löschte
 *      ihn, während der blockierte Sendeauftrag gespeichert weiterlebte. Die
 *      Seite sagte danach „bitte entscheiden" und bot keine Entscheidung an.
 *
 * Deshalb hängt der Konflikt jetzt am Einstellungsobjekt selbst und trägt
 * **beide** Stände. Nur dadurch ist die Zusage „beide bleiben erhalten" wahr.
 *
 * Die naheliegenden Auswege bleiben beide falsch:
 *
 *   - **Cloud gewinnt** verwirft die Einstellung, die jemand gerade bewusst
 *     gesetzt hat.
 *   - **Lokal gewinnt** schickt ein Objekt hoch, das vielleicht nur dieses eine
 *     Feld kennt, und löscht damit alles, was die Cloud sonst noch enthält.
 *
 * `settings` ist ein offener Beutel aus Schlüsseln; wer welchen gesetzt hat,
 * steht nicht darin. Deshalb wird pro Feld entschieden, und nur dort, wo die
 * Grundlage dafür gesichert ist:
 *
 *   1. **Welche Felder sind unsere?** `pendingKeys` sagt es, wenn der
 *      Schreibweg es vermerkt hat. Fehlt der Vermerk (Altbestand), kommen alle
 *      lokalen Schlüssel in Frage — geraten wird dabei nichts, siehe Punkt 2.
 *   2. **Was passiert mit einem solchen Feld?** Kennt die Cloud den Schlüssel
 *      gar nicht, wird er ergänzt; dabei geht nachweislich nichts verloren.
 *      Tragen beide denselben Wert, gibt es nichts zu tun. Tragen beide
 *      **verschiedene** Werte, kann niemand das auflösen: Beide Werte werden
 *      festgehalten und dem Nutzer vorgelegt.
 *
 * 01G hat Punkt 2 geschärft. Bis dahin gewann bei bekannter Absicht das lokale
 * Feld **stillschweigend** — auch wenn die Cloud dort etwas anderes führte. Das
 * ist dasselbe Raten, nur in die andere Richtung: Ein Wert, den jemand auf
 * einem zweiten Gerät bewusst gesetzt hat, verschwände ohne Frage. Ein echter
 * Wertwiderspruch ist immer eine Entscheidung.
 *
 * Nichts davon schreibt still über einen Wert hinweg.
 */
import type { WorkspaceSettings, WorkspaceSettingsFieldConflict } from '../../types/workspace';
import { getWorkspaceSettingsSnapshot, setWorkspaceSettings } from './workspaceStore';
import { completeBlockedOutboxEntry, releaseBlockedOutboxEntry } from '../sync/syncOutboxService';

export type { WorkspaceSettingsFieldConflict } from '../../types/workspace';

export type WorkspaceSettingsMergeOutcome =
  /** Nichts Lokales stand aus — der Cloud-Stand gilt unverändert. */
  | 'cloud_applied'
  /** Cloud als Basis, bewusst lokale Felder darübergelegt. */
  | 'merged'
  /** Mindestens ein Feld lässt sich nicht ohne Nutzerentscheidung auflösen. */
  | 'needs_decision';

export interface WorkspaceSettingsMergeResult {
  readonly outcome: WorkspaceSettingsMergeOutcome;
  /**
   * Der zusammengeführte Stand.
   *
   * Bei `needs_decision` ist das der **sichere Zwischenstand**: Cloud-Basis
   * plus alles, was eindeutig war. Die offenen Felder stehen bis zur
   * Entscheidung auf dem Cloud-Wert, der lokale Wunsch bleibt daneben in
   * `settings.conflict` erhalten.
   */
  readonly settings: WorkspaceSettings;
  /** Felder, die aus dem lokalen Stand übernommen wurden. */
  readonly keptLocalKeys: readonly string[];
  /** Felder, über die der Nutzer entscheiden muss. */
  readonly undecided: readonly WorkspaceSettingsFieldConflict[];
}

function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  /*
   * Ein Strukturvergleich über die kanonische JSON-Form. Für einen
   * Einstellungsbeutel reicht das: Die Werte sind Skalare, Listen und flache
   * Objekte, keine Funktionen und keine Zyklen.
   */
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Hat dieser lokale Stand etwas zu verlieren?
 *
 * Drei Anzeichen, und jedes einzelne genügt: ein vermerkter Schreibvorgang, ein
 * bereits festgehaltener Konflikt, oder ein noch offener Sendeauftrag. Fehlt
 * alles drei, gibt es nichts zu bewahren und der Cloud-Stand darf gelten.
 *
 * Diese Frage entscheidet, ob überhaupt zusammengeführt wird. Sie allein an der
 * Versionsnummer festzumachen war der Fehler: Bei gleicher Version griff der
 * Merge nicht, und das lokale Feld fiel weg.
 */
export function hasUnsyncedSettingsIntent(
  local: WorkspaceSettings | null | undefined,
  hasActiveOutboxEntry: boolean,
): boolean {
  if (hasActiveOutboxEntry) return true;
  if (!local) return false;
  if ((local.pendingKeys?.length ?? 0) > 0) return true;
  return (local.conflict?.fields.length ?? 0) > 0;
}

/**
 * Führt den lokalen Stand mit einem Cloud-Stand zusammen.
 *
 * Die Versionsnummer des Ergebnisses ist die der Cloud: Der zusammengeführte
 * Stand baut auf ihr auf, und nur mit ihr wird der anschliessende Push vom
 * Server angenommen.
 */
export function mergeWorkspaceSettings(
  local: WorkspaceSettings | null,
  cloud: WorkspaceSettings,
  now: string = new Date().toISOString(),
): WorkspaceSettingsMergeResult {
  if (!local) {
    return { outcome: 'cloud_applied', settings: cloud, keptLocalKeys: [], undecided: [] };
  }

  const localValues = local.settings ?? {};
  const cloudValues = cloud.settings ?? {};
  const merged: Record<string, unknown> = { ...cloudValues };
  const keptLocalKeys: string[] = [];
  const undecided: WorkspaceSettingsFieldConflict[] = [];

  /*
   * Ein bereits festgehaltener Konflikt zählt als bekannte Absicht: Dort steht
   * ein lokaler Wunsch, über den noch nicht entschieden wurde. Ihn bei einem
   * zweiten Abgleich zu vergessen, wäre derselbe stille Verlust noch einmal.
   */
  const offeneWuensche = new Map(
    (local.conflict?.fields ?? []).map((field) => [field.key, field.localValue]),
  );
  /*
   * Die Felder, die als „unsere" in Frage kommen. Mit Vermerk genau die
   * vermerkten; ohne Vermerk alle lokalen — was nicht heisst, dass sie gewinnen,
   * sondern nur, dass sie geprüft werden.
   */
  const kandidaten = local.pendingKeys ?? Object.keys(localValues);

  for (const key of kandidaten) {
    if (!(key in localValues)) continue;
    const lokalerWert = localValues[key];

    // Ein Schlüssel, den die Cloud nicht führt, kann dort nichts überschreiben.
    if (!(key in cloudValues)) {
      merged[key] = lokalerWert;
      keptLocalKeys.push(key);
      continue;
    }
    if (equalValue(lokalerWert, cloudValues[key])) continue;

    undecided.push({ key, localValue: lokalerWert, cloudValue: cloudValues[key] });
  }

  // Alte, noch unentschiedene Wünsche, die dieser Abgleich nicht erneut fand.
  for (const [key, localValue] of offeneWuensche) {
    if (undecided.some((field) => field.key === key)) continue;
    if (keptLocalKeys.includes(key)) continue;
    if (equalValue(localValue, merged[key])) continue;
    undecided.push({ key, localValue, cloudValue: cloudValues[key] });
  }

  const settings: WorkspaceSettings = {
    ...cloud,
    settings: merged,
    /*
     * Was übernommen wurde, steht noch nicht in der Cloud und bleibt deshalb
     * ausstehend — sonst ginge es beim nächsten Pull wieder verloren.
     */
    pendingKeys: keptLocalKeys.length > 0 ? [...keptLocalKeys] : undefined,
    conflict: undecided.length > 0 ? { fields: [...undecided], detectedAt: now } : undefined,
  };

  if (undecided.length > 0) {
    return { outcome: 'needs_decision', settings, keptLocalKeys, undecided };
  }
  return {
    outcome: keptLocalKeys.length > 0 ? 'merged' : 'cloud_applied',
    settings,
    keptLocalKeys,
    undecided: [],
  };
}

export type WorkspaceSettingsDecision = 'keep_local' | 'take_cloud';

/**
 * Wendet die Entscheidung des Nutzers auf die offenen Felder an.
 *
 * `keep_local` legt die strittigen lokalen Werte über die Cloud-Basis und
 * markiert sie als ausstehend, damit der nächste Push sie überträgt.
 * `take_cloud` lässt die Cloud-Werte stehen und verwirft den lokalen Wunsch —
 * ausdrücklich gewählt, nicht geraten. In beiden Fällen ist der Konflikt danach
 * beendet.
 */
export function applyWorkspaceSettingsDecision(
  merged: WorkspaceSettings,
  undecided: readonly WorkspaceSettingsFieldConflict[],
  decision: WorkspaceSettingsDecision,
): WorkspaceSettings {
  if (decision === 'take_cloud' || undecided.length === 0) {
    return { ...merged, conflict: undefined };
  }
  const settings = { ...merged.settings };
  for (const conflict of undecided) {
    settings[conflict.key] = conflict.localValue;
  }
  return {
    ...merged,
    settings,
    conflict: undefined,
    pendingKeys: [
      ...new Set([...(merged.pendingKeys ?? []), ...undecided.map((item) => item.key)]),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Die offene Entscheidung                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Der offene Feldkonflikt — gelesen dort, wo er gespeichert ist.
 *
 * Bewusst **kein** eigener Modulzustand mehr: Der überlebte in 01B keinen
 * Reload, während der blockierte Sendeauftrag es tat. Genau diese Schieflage
 * erzeugte die Anzeige „bitte entscheiden" ohne Entscheidungsmöglichkeit.
 */
export function getPendingWorkspaceSettingsConflict(): {
  settings: WorkspaceSettings;
  undecided: WorkspaceSettingsFieldConflict[];
} | null {
  const settings = getWorkspaceSettingsSnapshot();
  const fields = settings?.conflict?.fields ?? [];
  if (!settings || fields.length === 0) return null;
  return { settings, undecided: [...fields] };
}

/**
 * Die Entscheidung des Nutzers wirksam machen.
 *
 * Drei Dinge gehören zusammen und dürfen nicht auseinanderfallen: Der
 * aufgelöste Stand wird lokal gültig, der Konflikt verschwindet, und der
 * blockierte Sendeauftrag wird aufgelöst. Bliebe der letzte Schritt aus, wäre
 * der Konflikt zwar entschieden, die Einstellung aber weiterhin nicht
 * übertragbar — genau die Sackgasse, die 01B beheben sollte.
 *
 * Die beiden Wege enden unterschiedlich, und das ist Absicht:
 *
 *   - **Lokal behalten** braucht eine Übertragung. Der Auftrag geht mit der
 *     **Cloud-Version** als Basis zurück in die Warteschlange; nur mit ihr
 *     nimmt der Server den nächsten Push an.
 *   - **Cloud übernehmen** braucht keine. Es gibt nichts mehr zu senden, also
 *     wird der Auftrag abgeschlossen statt erneut eingereiht — sonst bliebe ein
 *     gegenstandsloser Rest in der Warteschlange stehen.
 */
export function resolveWorkspaceSettingsConflict(decision: WorkspaceSettingsDecision): boolean {
  const offen = getPendingWorkspaceSettingsConflict();
  if (!offen) return false;

  const aufgeloest = applyWorkspaceSettingsDecision(offen.settings, offen.undecided, decision);
  setWorkspaceSettings(aufgeloest);

  if (decision === 'keep_local') {
    releaseBlockedOutboxEntry('workspace_settings', aufgeloest.workspaceId, aufgeloest.version);
  } else {
    completeBlockedOutboxEntry('workspace_settings', aufgeloest.workspaceId);
  }
  return true;
}
