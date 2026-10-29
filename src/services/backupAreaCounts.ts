import { BACKUP_AREA_KEYS, type BackupAreaCounts } from '../types/backupExport';
import type { AppPersistedState } from '../types/models';

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.23 „Vollständige Zählung“, D-03.2) — die Zahl je fachlichem Bereich.
 *
 * Dieselbe Funktion zählt vor dem Download, beim Erstellen (Manifest) und beim Prüfen einer Sicherung; die Prüfung
 * weist ein Manifest ab, dessen Zählung nicht zum enthaltenen Bestand passt. Zuordnung:
 * - Rechnungen: die eigenständige Rechnungsablage (`invoiceEntries`); ein Altbestand ohne sie zählt die Rechnungen in
 *   den Vorgängen.
 * - Zahlungen: Zahlungseingänge der Rechnungen und Zahlungen der Ausgaben (Mitarbeiterzahlungen zählen eigens).
 * - Dokumente: die Dokumentablage; Dateien: die Dateien in der Sicherung (vor dem Download: die referenzierten).
 * - E-Mails: auf diesem Gerät übernommene E-Mails. Gesendete und empfangene Postfach-E-Mails liegen auf dem Server
 *   und gehören nicht zum Bestand dieses Geräts.
 * - Einstellungen: vorhandene Einstellungssätze (Einrichtung, Firmenprofil, Betriebseinstellungen, Nummernkreis).
 */
export function buildBackupAreaCounts(state: AppPersistedState, fileCount: number): BackupAreaCounts {
  const invoices = state.invoiceEntries
    ? state.invoiceEntries.map((entry) => entry.invoice)
    : (state.vorgaenge ?? []).flatMap((vorgang) => vorgang.invoices ?? []);
  const invoicePayments = invoices.reduce((sum, invoice) => sum + (invoice?.payments?.length ?? 0), 0);
  const expensePayments = (state.expenses ?? []).reduce((sum, expense) => sum + (expense.payments?.length ?? 0), 0);
  const settings = [state.setup, state.companyProfile, state.workspaceSettings, state.invoiceNumberSequence].filter(
    (value) => value !== undefined && value !== null,
  ).length;
  return {
    customers: state.customers?.length ?? 0,
    vorgaenge: state.vorgaenge?.length ?? 0,
    offers: state.offers?.length ?? 0,
    invoices: invoices.length,
    payments: invoicePayments + expensePayments,
    expenses: state.expenses?.length ?? 0,
    documents: state.documents?.length ?? 0,
    files: fileCount,
    letters: state.businessLetters?.length ?? 0,
    emails: state.mailImports?.length ?? 0,
    tasks: state.tasks?.length ?? 0,
    knowledge: state.knowledgeFacts?.length ?? 0,
    bankTransactions: state.bankTransactions?.length ?? 0,
    employees: state.employees?.length ?? 0,
    employeePayments: state.employeePayments?.length ?? 0,
    accountingAssignments: state.accountingAssignments?.length ?? 0,
    settings,
  };
}

/**
 * Liest die Bereichszählung eines Manifests. `undefined`: Sicherung von vor dieser Zählung (zulässig);
 * `null`: vorhanden, aber ungültig (das Manifest wird abgewiesen).
 */
export function parseBackupAreaCounts(raw: unknown): BackupAreaCounts | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const counts = {} as BackupAreaCounts;
  for (const key of BACKUP_AREA_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    counts[key] = value;
  }
  return counts;
}

export function sameBackupAreaCounts(a: BackupAreaCounts, b: BackupAreaCounts): boolean {
  return BACKUP_AREA_KEYS.every((key) => a[key] === b[key]);
}
