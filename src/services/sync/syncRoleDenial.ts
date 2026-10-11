/**
 * GO-LIVE-SECURITY-01 — Rollenabweisungen des Servers im Sync.
 *
 * Löschen ist Verwaltung (nur Inhaber und Admin). Ein Gerät mit veralteter
 * Rollenauskunft, oder ein Altzustand aus der Zeit vor dieser Regel, schickt
 * trotzdem einen Grabstein, und der Server weist ihn mit „Keine
 * Schreibberechtigung" ab. Dieser Auftrag kann nie gelingen. Er ist kein
 * Übertragungsfehler, sondern der Beweis, dass der lokale Stand nicht
 * freigegeben ist: Es gilt der Stand der Cloud.
 *
 * Bisher blieb so ein Auftrag für immer als Fehler stehen, wurde bei jedem
 * Lauf erneut gesendet und hielt den Abgleich an — das Gerät holte danach gar
 * nichts mehr ab, und das gelöschte Dokument blieb nur dort verschwunden.
 */
import type { SyncEntityType, SyncMeta, SyncOutboxEntry } from '../../types/sync';
import { isFinancialActionDenial } from '../auth/financialActionDenial';

/** Die Rollenabweisung der Schreibwege (Eingangsweg, generischer Schreibweg). */
export const ROLE_DENIAL_MESSAGE = 'Keine Schreibberechtigung';

/**
 * GO-LIVE-SECURITY-01 / ABSCHLUSS — dazu die Abweisungen der Finanzwege
 * (`assert_financial_action_allowed`: `finance_forbidden_role`, gesperrtes Konto,
 * Lizenz). Sie tragen nicht den Text oben, sind aber ebenso endgültig für diesen
 * Stand: Ausgaben, Kontierung, Monatsabschluss oder Mitarbeiterzahlungen eines
 * Geräts mit veralteter Rolle hielten sonst bei jedem Lauf den ganzen Abgleich an.
 * Der Auftrag bleibt stehen (nach einer Lizenzverlängerung gelingt er), der
 * Abgleich läuft weiter.
 */
export function isRoleDenialMessage(message: string | null | undefined): boolean {
  const text = message ?? '';
  return text.includes(ROLE_DENIAL_MESSAGE) || isFinancialActionDenial(text) || isFinalPermissionDenialMessage(text);
}

/**
 * GO-LIVE-SECURITY-01 / KONTOSPERRE — Abweisungen, nach denen dieser Auftrag NIE
 * automatisch erneut gesendet werden darf.
 *
 * Seit 20261109 weist der Server jede Aktion eines gesperrten Kontos ab: meist mit
 * „Kein Zugriff auf Workspace" (es ist kein aktives Mitglied mehr), sonst mit
 * „Keine Schreibberechtigung", `account_blocked` oder `finance_account_blocked`.
 * Blieb so ein Auftrag als `error` stehen, sendete jeder automatische Lauf ihn
 * erneut — und nach dem Entsperren nahm der Server die während der Sperre
 * abgewiesene Archivlöschung an. Dieselbe Endgültigkeit gilt für eine fehlende
 * Rolle oder Mitgliedschaft und ein nicht freigegebenes Konto.
 *
 * Bewusst NICHT dabei: abgelaufene oder inaktive Lizenz (`finance_license_*`).
 * Diese Aufträge bleiben stehen und gelingen nach einer Lizenzverlängerung —
 * so wie oben beschrieben.
 */
const FINAL_PERMISSION_DENIALS = [
  ROLE_DENIAL_MESSAGE,
  'Kein Zugriff',
  'account_blocked',
  'finance_forbidden_role',
  'finance_account_not_approved',
] as const;

export function isFinalPermissionDenialMessage(message: string | null | undefined): boolean {
  const text = message ?? '';
  return FINAL_PERMISSION_DENIALS.some((marker) => text.includes(marker));
}

/**
 * Ein endgültig abgewiesener Auftrag: Endstatus `failed` mit einer Meldung von oben.
 * Er wird nicht gesendet, nicht per „Erneut versuchen" wiederbelebt und von keinem
 * Backfill neu eingereiht; erst eine neue, bewusst ausgelöste Änderung erzeugt einen
 * neuen Auftrag.
 */
export function isFinallyDeniedOutboxEntry(entry: SyncOutboxEntry): boolean {
  return entry.status === 'failed' && isFinalPermissionDenialMessage(entry.lastErrorMessage);
}

/** Ein Sendefehler des laufenden Laufs, der eine endgültige Rollenabweisung ist. */
export function isRoleDenialFailure(failure: { message: string; retryable?: boolean }): boolean {
  return failure.retryable === false && isRoleDenialMessage(failure.message);
}

/**
 * Ein Auftrag, den der Server wegen der Rolle abgewiesen hat. KONTOSPERRE: auch der
 * Endstatus `failed` — sonst bliebe ein endgültig abgewiesener Grabstein nach dem
 * Entsperren lokal für immer stehen, statt dem Cloud-Stand zu weichen.
 */
export function isRoleDeniedOutboxEntry(entry: SyncOutboxEntry): boolean {
  return (
    (entry.status === 'error' || entry.status === 'blocked' || entry.status === 'failed') &&
    isRoleDenialMessage(entry.lastErrorMessage)
  );
}

/**
 * Abgewiesene Löschungen eines Entitätstyps, deren Cloud-Zeile nachweislich
 * lebt: Der lokale Grabstein weicht dem Cloud-Stand, der Auftrag gilt als
 * erledigt. Ohne lebende Cloud-Zeile bleibt alles, wie es ist.
 */
export function planRoleDeniedTombstoneRestore(
  outbox: readonly SyncOutboxEntry[] | undefined,
  entityType: SyncEntityType,
  localEntities: ReadonlyArray<{ id: string; sync?: SyncMeta }>,
  liveRemoteIds: ReadonlySet<string>,
): { entityIds: Set<string>; outboxIds: string[] } {
  const tombstones = new Set(localEntities.filter((entity) => entity.sync?.deleted === true).map((entity) => entity.id));
  const entityIds = new Set<string>();
  const outboxIds: string[] = [];
  for (const entry of outbox ?? []) {
    if (entry.entityType !== entityType || !isRoleDeniedOutboxEntry(entry)) continue;
    if (!tombstones.has(entry.entityId) || !liveRemoteIds.has(entry.entityId)) continue;
    entityIds.add(entry.entityId);
    outboxIds.push(entry.id);
  }
  return { entityIds, outboxIds };
}
