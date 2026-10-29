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
 * Der Auftrag bleibt abgewiesen, der Abgleich läuft weiter.
 *
 * EINRICHTUNG-01 (AP1, Vertrag 1.8) — eine beendete Sitzung ist nie eine
 * Rollenabweisung, auch wenn eine Meldung beides nennt.
 */
export function isRoleDenialMessage(message: string | null | undefined): boolean {
  const text = message ?? '';
  if (isSessionNotActiveMessage(text)) return false;
  return text.includes(ROLE_DENIAL_MESSAGE) || isFinancialActionDenial(text) || isFinalPermissionDenialMessage(text);
}

/**
 * EINRICHTUNG-01 (AP1, Vertrag 1.8) — die Sitzung des Tokens besteht nicht mehr
 * (abgemeldet, „auf allen Geräten abmelden“, abgelaufen). Der Server weist dann
 * jeden Zugriff mit diesem Code ab, bevor er Konto, Mitgliedschaft oder Rolle
 * prüft. Das sagt nichts über die Rechte: Der Client verlangt die Anmeldung, die
 * Aufträge bleiben beim Ursprung und laufen nach der Anmeldung desselben Kontos
 * weiter. Deshalb nie endgültig.
 */
export const SESSION_NOT_ACTIVE_CODE = 'session_not_active';

export function isSessionNotActiveMessage(message: string | null | undefined): boolean {
  return (message ?? '').includes(SESSION_NOT_ACTIVE_CODE);
}

/**
 * EINRICHTUNG-01 (AP1, Vertrag 1.9) — Rolle oder Mitgliedschaft änderten sich
 * während der Prüfung (SQLSTATE 40001). Nichts wurde geschrieben; der nächste Lauf
 * prüft mit dem neuen Stand und erhält die endgültige Antwort.
 */
export const WORKSPACE_ACCESS_CHANGED_CODE = 'workspace_access_changed';

export function isWorkspaceAccessChangedMessage(message: string | null | undefined): boolean {
  return (message ?? '').includes(WORKSPACE_ACCESS_CHANGED_CODE);
}

/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.7, M-10.3) — der Server kennt das Konto in genau diesem Betrieb nicht (mehr) als
 * aktives Mitglied (entfernt, verlassen; seit 20261109 auch bei Kontosperre). Für die Bindung an diesen Betrieb ist das
 * ein bestätigter Entzug, kein technischer Fehler.
 */
export const WORKSPACE_NO_ACCESS_MESSAGE = 'Kein Zugriff auf Workspace';

export function isWorkspaceNoAccessMessage(message: string | null | undefined): boolean {
  return (message ?? '').includes(WORKSPACE_NO_ACCESS_MESSAGE);
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
 * EINRICHTUNG-01 (AP1, Vertrag 1.7, N-Z4.4/N-Z4.5) — dazu die nicht wirksame
 * Betriebslizenz: `license_not_effective` der Schreibwege, `finance_license_*` der
 * Finanzwege, und die fehlende Freigabe `account_not_approved`. Bis dahin blieben
 * Lizenzabweisungen bewusst offen und wurden nach einer Verlängerung nachgeholt. Der mit
 * WEISS abgestimmte Katalog V3 legt fest: Eine Rechtewiederkehr oder
 * Lizenzverlängerung führt endgültig abgewiesene Aufträge nicht aus. Im
 * Nur-Lesen-Zustand (Vertrag 1.3) entstehen keine neuen; eine neue, bewusste
 * Änderung nach der Verlängerung erzeugt einen neuen Auftrag.
 *
 * Bewusst NICHT dabei: die beendete Sitzung (`session_not_active`, siehe oben)
 * und die gleichzeitige Rechteänderung (`workspace_access_changed`).
 */
const FINAL_PERMISSION_DENIALS = [
  ROLE_DENIAL_MESSAGE,
  'Kein Zugriff',
  'account_blocked',
  'finance_forbidden_role',
  'finance_account_not_approved',
  'account_not_approved',
  'license_not_effective',
  'finance_license_expired',
  'finance_license_inactive',
] as const;

export function isFinalPermissionDenialMessage(message: string | null | undefined): boolean {
  const text = message ?? '';
  if (isSessionNotActiveMessage(text) || isWorkspaceAccessChangedMessage(text)) return false;
  return FINAL_PERMISSION_DENIALS.some((marker) => text.includes(marker));
}

/**
 * EINRICHTUNG-01 (AP1, Vertrag 1.7) — eine Abweisung, mit der der Server bestätigt, dass die Betriebslizenz des
 * Betriebs nicht wirksam ist. Die Oberfläche fragt danach sofort den Lizenzstand ab (Nur-Lesen, Vertrag 1.3).
 */
const WORKSPACE_LICENSE_REJECTIONS = ['license_not_effective', 'finance_license_expired', 'finance_license_inactive'] as const;

export function isWorkspaceLicenseRejectionMessage(message: string | null | undefined): boolean {
  const text = message ?? '';
  return WORKSPACE_LICENSE_REJECTIONS.some((marker) => text.includes(marker));
}

/**
 * FINANZ-CORE-01A (Gesamtnacharbeit INV-08/09) — fachliche Abweisungen der Ausgabenregeln. Kein
 * Rollenproblem, aber ebenso endgültig für diesen Auftrag: Derselbe Inhalt wird beim nächsten Versuch
 * genauso abgewiesen (Zahlung auf Entwurf oder Gutschrift, unbestätigte Überzahlung, Betrag/Storno/
 * Entwurf/Löschen trotz Zahlung, stornierte oder gelöschte Ausgabe, ungültiger Betrag oder Tag). Erst
 * eine neue, bewusste Änderung erzeugt einen neuen Auftrag; nach einem Neustart wird nichts nachgeholt.
 */
const FINAL_BUSINESS_REJECTIONS = [
  'expense_payment_not_payable',
  'expense_payment_overpayment_unconfirmed',
  'expense_amount_locked_after_payment',
  'expense_cancel_has_payments',
  'expense_cancel_not_booked',
  'expense_status_locked_after_payment',
  'expense_cancelled_immutable',
  'Ausgabe hat gebuchte Zahlungen',
  'Ausgabe storniert',
  'Ausgabe geloescht',
  'Ausgabe bereits geloescht',
  'amount ungueltig',
  'paid_on ungueltig',
  // INV-10 — ein freigegebenes Angebot ist ein Beleg; eine Änderung daran wird nie angenommen.
  'Angebot ist freigegeben und kann nicht mehr geaendert werden',
  /*
   * P1-KORREKTUR A04-WEISS-R1/R2 — der Serververtrag der Steueraufteilung: widersprüchliche oder unzulässige
   * Aufteilung bzw. Abzugsangabe, Zahlung auf eine offene Aufteilung, Änderung in einem mit älterer Fassung
   * abgeschlossenen Monat. Derselbe Auftrag scheitert beim nächsten Mal genauso.
   */
  'expense_tax_split_',
  'expense_input_tax_deduction_',
  'expense_payment_tax_split_open',
] as const;

/**
 * Systemische Gesamtnacharbeit (D7) — fachliche Abweisungen eines Monatsabschlusses: falsches oder veraltetes
 * Manifest, nicht abschlussbereit, alte Fassung, Monat bereits abgeschlossen. Bisher liefen sie als wiederholbarer
 * Fehler endlos weiter. Derselbe Auftrag scheitert beim nächsten Mal genauso; erst ein neuer, bewusster Abschluss
 * (neue Revision) kann angenommen werden.
 */
export const CLOSURE_BUSINESS_REJECTIONS = [
  'closure_manifest_mismatch',
  'closure_fingerprint_mismatch',
  'closure_manifest_version_outdated',
  'closure_not_ready',
  'closure_id_conflict',
  'closure_manifest_invalid',
  'closure_manifest_period_mismatch',
  'closure_without_fingerprint',
  'period_already_closed',
  'period_invalid',
] as const;

export function isClosureBusinessRejection(message: string | null | undefined): boolean {
  const text = message ?? '';
  return CLOSURE_BUSINESS_REJECTIONS.some((marker) => text.includes(marker));
}

export function isFinalBusinessRejectionMessage(message: string | null | undefined): boolean {
  const text = message ?? '';
  return FINAL_BUSINESS_REJECTIONS.some((marker) => text.includes(marker)) || isClosureBusinessRejection(text);
}

/**
 * Ein endgültig abgewiesener Auftrag: Endstatus `failed` mit einer Meldung von oben.
 * Er wird nicht gesendet, nicht per „Erneut versuchen" wiederbelebt und von keinem
 * Backfill neu eingereiht; erst eine neue, bewusst ausgelöste Änderung erzeugt einen
 * neuen Auftrag.
 */
export function isFinallyDeniedOutboxEntry(entry: SyncOutboxEntry): boolean {
  return (
    entry.status === 'failed' &&
    (isFinalPermissionDenialMessage(entry.lastErrorMessage) || isFinalBusinessRejectionMessage(entry.lastErrorMessage))
  );
}

/** Ein Sendefehler des laufenden Laufs, der eine endgültige Rollenabweisung ist. */
export function isRoleDenialFailure(failure: { message: string; retryable?: boolean }): boolean {
  return failure.retryable === false && isRoleDenialMessage(failure.message);
}

/**
 * FINANZ-CORE-01A (END18-R3) — ein Sendefehler, der endgültig ist: Rollenabweisung oder fachliche
 * Abweisung. Beide verlangen den Abgleich im selben Lauf — erst der Serverstand nimmt die lokale
 * Wirkung der abgewiesenen Aktion zurück (`mergeExpensesFromPull`). Netzfehler gehören nicht dazu.
 */
export function isFinalRejectionFailure(failure: { message: string; retryable?: boolean }): boolean {
  return (
    failure.retryable === false &&
    (isRoleDenialMessage(failure.message) || isFinalBusinessRejectionMessage(failure.message))
  );
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
