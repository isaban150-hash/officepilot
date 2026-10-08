/**
 * STEUERBERATER-06B — der Monatsabschluss.
 *
 * Ein Abschluss ist **kein Boolean und kein Schloss**. Er ist ein festgehaltener
 * Stand: Welche Belege gehörten dazu, wie waren sie kontiert, und woran erkennt
 * man später, dass sich seitdem etwas geändert hat.
 *
 * Bewusst **keine** Compliance-Zusage. OfficeTakt verhindert nach einem
 * Abschluss nichts — der Betrieb hat Storno-, Korrektur- und
 * Zahlungsworkflows, und die bleiben. Was der Abschluss leistet, ist
 * Wiedererkennung: Ändert sich danach etwas steuerlich Relevantes, sagt die
 * Anwendung das, statt weiter „Abgeschlossen" zu behaupten.
 *
 * Deshalb steht hier nirgends „festgeschrieben", „GoBD" oder „rechtssicher".
 * Für solche Worte fehlt die Grundlage, und ein Versprechen, das die Software
 * nicht einlöst, ist schlimmer als keines.
 */
import type { SyncMeta } from './sync';

/**
 * Der Stand eines Monats.
 *
 *   `open`                 — noch nichts kontiert, nichts zu entscheiden.
 *   `not_ready`            — es gibt Belege, aber offene Punkte.
 *   `ready`                — alles bestätigt, nichts blockiert. **Abgeleitet**,
 *                            nie von Hand gesetzt.
 *   `closed`               — abgeschlossen, und die Daten passen noch dazu.
 *   `changed_after_close`  — abgeschlossen, aber seitdem hat sich etwas
 *                            steuerlich Relevantes geändert.
 */
export type AccountingPeriodReadiness =
  | 'open'
  | 'not_ready'
  | 'ready'
  | 'closed'
  | 'changed_after_close';

/** Warum ein Monat nicht abgeschlossen werden kann. */
export type AccountingPeriodBlockerCode =
  | 'unassigned_documents'
  | 'needs_review'
  | 'needs_clarification'
  | 'confirmed_without_account'
  | 'money_integrity';

export interface AccountingPeriodBlocker {
  readonly code: AccountingPeriodBlockerCode;
  /** Wie viele Belege betroffen sind. */
  readonly count: number;
  /** Die betroffenen Belege, für die Anzeige. */
  readonly sourceIds: readonly string[];
}

/**
 * Ein Beleg im Abschlussmanifest.
 *
 * Bewusst schmal: nur, was steuerlich zählt. Keine Kopie des Dokuments, kein
 * PDF, kein Bild — ein Manifest soll den Stand belegen, nicht den Bestand
 * verdoppeln.
 */
export interface AccountingPeriodManifestEntry {
  readonly sourceType: 'expense' | 'invoice';
  readonly sourceId: string;
  readonly belegnummer: string;
  readonly datum: string;
  readonly brutto: number;
  readonly netto: number;
  readonly steuer: number;
  /** `aktiv`, `storniert` oder `storno` — der Stornozustand gehört dazu. */
  readonly belegStatus: string;
  readonly accountNumber: string;
  readonly taxTreatment: string;
  readonly bookingText: string;
  readonly assignmentStatus: string;
  /**
   * 02B (ab Version 2) — die Belegart. Original und Storno derselben Rechnung
   * sind zwei Einträge; die Belegart unterscheidet sie deterministisch.
   */
  readonly belegart?: string;
}

/**
 * P0/P1-INTEGRITAET 01B / P2 — eine Zahlung, deren Zahlungsdatum im
 * Abschlussmonat liegt. Nicht der heutige Zahlungsstatus der Rechnung: eine
 * Zahlung im Folgemonat ändert den abgeschlossenen Monat nicht.
 */
export interface AccountingPeriodManifestPayment {
  readonly sourceType: 'expense' | 'invoice';
  readonly sourceId: string;
  readonly paymentId: string;
  readonly datum: string;
  readonly betrag: number;
}

/**
 * P1 MITARBEITERZAHLUNGEN (ab Version 3) — eine Zahlung an einen Mitarbeiter,
 * deren Auszahlungsdatum im Abschlussmonat liegt (Stand zum Monatsende), bzw.
 * der Storno einer früheren solchen Zahlung im Stornomonat.
 */
export interface AccountingPeriodManifestEmployeePayment {
  readonly paymentId: string;
  readonly art: 'zahlung' | 'storno';
  readonly datum: string;
  readonly betrag: number;
  readonly kind: string;
  readonly method: string;
  readonly status: string;
}

/**
 * Version des Fingerprint-Algorithmus. Fehlt sie, entstand der Abschluss mit
 * Version 1 (ohne Zahlungen) und wird nach genau dieser Logik geprüft.
 * Version 3 (P1 MITARBEITERZAHLUNGEN) nimmt die Mitarbeiterzahlungen hinzu;
 * Abschlüsse der Versionen 1 und 2 bleiben nach ihrer eigenen Logik gültig.
 */
export type AccountingPeriodFingerprintVersion = 1 | 2 | 3;

export interface AccountingPeriodManifest {
  readonly fingerprintVersion?: AccountingPeriodFingerprintVersion;
  readonly monthKey: string;
  readonly chartOfAccounts: string;
  readonly documentCount: number;
  readonly totalBrutto: number;
  readonly totalNetto: number;
  readonly totalSteuer: number;
  /** Kanonisch sortiert, damit derselbe Stand dieselbe Reihenfolge ergibt. */
  readonly entries: readonly AccountingPeriodManifestEntry[];
  /** Ab Version 2: Zahlungen des Monats, kanonisch sortiert. */
  readonly payments?: readonly AccountingPeriodManifestPayment[];
  /** Ab Version 3: Mitarbeiterzahlungen des Monats, kanonisch sortiert. */
  readonly employeePayments?: readonly AccountingPeriodManifestEmployeePayment[];
}

/**
 * Eine Abschlussrevision.
 *
 * Revisionen werden **angehängt, nie überschrieben**. Wird ein Monat wieder
 * geöffnet und erneut abgeschlossen, entsteht Revision 2; Revision 1 behält
 * ihren Fingerprint und ihr Manifest. Eine alte Revision nachträglich auf einen
 * neuen Stand umzuschreiben hiesse, den Nachweis zu fälschen.
 */
export interface AccountingPeriodClosure {
  readonly id: string;
  readonly monthKey: string;
  readonly revision: number;
  readonly closedAt: string;
  readonly closedBy?: string;
  /** Der Stand, auf den sich dieser Abschluss bezieht. */
  readonly fingerprint: string;
  readonly manifest: AccountingPeriodManifest;
  readonly reopenedAt?: string;
  readonly reopenedBy?: string;
  readonly reopenReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sync?: SyncMeta;
}

/**
 * Der vollständige Stand eines Monats — die API, die der DATEV-Block (06C)
 * benutzen soll.
 */
export interface AccountingPeriodState {
  readonly monthKey: string;
  readonly readiness: AccountingPeriodReadiness;
  readonly blockers: readonly AccountingPeriodBlocker[];
  /** Der Fingerprint des **aktuellen** Datenstands. */
  readonly currentFingerprint: string;
  readonly currentManifest: AccountingPeriodManifest;
  /** Die noch nicht wieder geöffnete Revision, falls es eine gibt. */
  readonly activeClosure: AccountingPeriodClosure | null;
  /**
   * Passt der aktive Abschluss noch zum heutigen Datenstand?
   *
   * `false` heisst: erneute Prüfung nötig. Der Abschluss selbst bleibt
   * erhalten — er war zu seiner Zeit richtig.
   */
  readonly isCurrentClosureValid: boolean;
  /** Alle Revisionen dieses Monats, neueste zuerst. */
  readonly revisionHistory: readonly AccountingPeriodClosure[];
}
