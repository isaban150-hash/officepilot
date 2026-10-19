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
  | 'money_integrity'
  /** FINANZ-CORE-01A (END18-R3) — Finanzänderungen, die der Server noch nicht bestätigt hat. */
  | 'unconfirmed_financial_changes'
  /** Systemische Gesamtnacharbeit (SYS-02 / D5) — das letzte Speichern ist gescheitert. */
  | 'persist_failed';

/**
 * FINANZ-CORE-01A (Bericht 20) — eine Quelle mit noch nicht bestätigter Finanzwirkung im Monat (siehe
 * `collectUnconfirmedFinancialSources`). Nur für Anzeige und Nachweis; die Sperre selbst ist der Blocker.
 */
export interface AccountingPeriodUnconfirmedSource {
  readonly sourceType: 'expense' | 'employee_payment' | 'accounting_assignment' | 'invoice_payment';
  readonly sourceId: string;
  readonly reason: string;
  readonly outboxId?: string;
  readonly paymentId?: string;
}

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
  /**
   * FC01A-P1-Restkorrektur (lokaler Altbestand) — `null` für eine Ausgangsrechnung mit ungeklärtem
   * Netto (`MonatsmappeBeleg.netto`); im Fingerprint als `ungeklaert`, nie als geschätzte Zahl.
   */
  readonly netto: number | null;
  readonly steuer: number | null;
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
  /**
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-04, ab Version 4) — was der Export zum Beleg ausweist:
   * Skontoabzug (Entgeltminderung), Zahlungsstatus und offener Betrag zum Monatsende.
   */
  readonly skontoAbzug?: number;
  readonly zahlungsstatus?: string;
  readonly offenerBetrag?: number;
  /** Ab Version 5: der Kontenrahmen der Kontierung (`SKR03`/`SKR04`, sonst leer). */
  readonly kontenrahmen?: string;
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
  /**
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-04, ab Version 4) — der Skontoabzug dieser Zahlung (negativ:
   * Rücknahme, INV-05) und die Zahlungsart, wie `zahlungen.csv` sie ausweist.
   */
  readonly skontoAbzug?: number;
  readonly zahlungsart?: string;
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
 * Version 4 (FINANZ-CORE-01A, Gesamtnacharbeit INV-04) bindet zusätzlich die exportrelevanten Zahlungs-
 * und Skontowerte; Abschlüsse der Versionen 1 bis 3 bleiben nach ihrer Logik gültig und zeigen ihre Grenze.
 */
export type AccountingPeriodFingerprintVersion = 1 | 2 | 3 | 4 | 5;

/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, SYS-03) — ab Version 5: die kumulierten offenen Posten zum
 * Monatsende (Forderungen und Verbindlichkeiten aller Belege bis zum Stichtag), wie `offene_posten_monatsende.csv`
 * sie ausweist. Eine Vorperiodenzahlung, eine Rücknahme oder ein Storno ändert damit die Revision.
 */
export interface AccountingPeriodManifestOpenItem {
  readonly belegart: 'ausgangsrechnung' | 'eingangsbeleg';
  readonly belegId: string;
  readonly datum: string;
  readonly brutto: number;
  readonly bezahlt: number;
  readonly offen: number;
  readonly faelligAm: string;
}

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
  /** Ab Version 5: kumulierte offene Posten zum Monatsende, kanonisch sortiert. */
  readonly offenePosten?: readonly AccountingPeriodManifestOpenItem[];
}

/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, E1/F35) — was der Server zu einer Revision nachweislich gesagt hat.
 * Nur eine Serverantwort auf den Abschluss oder ein Abzug einer servervalidierten Revision setzt `validiert`; ohne
 * diesen Nachweis ist eine Revision nie „angenommen“ (positive Evidenz).
 */
export interface AccountingPeriodServerConfirmation {
  /** Revisionsnummer des Servers. */
  readonly revision: number;
  /** Fingerabdruck, den der Server für seinen eigenen Bestand gebildet hat. */
  readonly fingerprint: string;
  /** Der Server hat das Manifest gegen seinen Finanzbestand geprüft (Fassung 5). */
  readonly validiert: boolean;
  /** Finanzdatenstand des Betriebs, gegen den geprüft wurde. */
  readonly datenstand?: number;
  readonly bestaetigtAm: string;
}

/**
 * Systemische Gesamtnacharbeit (D7) — der Server hat diese Revision endgültig abgewiesen (falsches oder veraltetes
 * Manifest, nicht abschlussbereit, alte Fassung, Monat bereits abgeschlossen). Dauerhaft an der Revision gespeichert:
 * Sie gilt danach nicht mehr als aktiver Abschluss, wird nie automatisch erneut gesendet und bleibt in der Historie
 * sichtbar. Ein neuer Abschluss ist eine neue Revision.
 */
export interface AccountingPeriodCloudRejection {
  readonly meldung: string;
  readonly am: string;
}

/**
 * Systemische Gesamtnacharbeit (D1, Produktentscheidung) — was eine Revision gegenüber der Cloud ist:
 *  - `angenommen`: vom Server gegen seinen Finanzbestand geprüft und angenommen (Fassung 5, positive Evidenz);
 *  - `lokal`: Betrieb ohne Cloud — ein rein lokaler Abschluss, sichtbar als solcher;
 *  - `ausstehend`: noch nicht vom Server bestätigt (nicht gesendet, Netz, Antwort verloren);
 *  - `abgewiesen`: vom Server endgültig abgewiesen;
 *  - `konflikt`: Versionskonflikt, wartet auf eine Entscheidung;
 *  - `historisch`: ältere Revision (Fassung 1–4) — lesbar, aber nie serverzertifiziert.
 */
export type AccountingPeriodRevisionStatus = 'angenommen' | 'lokal' | 'ausstehend' | 'abgewiesen' | 'konflikt' | 'historisch';

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
  /** Systemische Gesamtnacharbeit (E1) — Serverbestätigung; fehlt sie, ist die Revision nicht cloudbestätigt. */
  readonly server?: AccountingPeriodServerConfirmation;
  /** Systemische Gesamtnacharbeit (D7) — endgültige Abweisung durch den Server; die Revision ist dann nicht aktiv. */
  readonly cloudAbweisung?: AccountingPeriodCloudRejection;
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
  /** Bericht 20 — was der Server in diesem Monat noch nicht bestätigt hat (Grundlage des Blockers). */
  readonly unconfirmedSources?: readonly AccountingPeriodUnconfirmedSource[];
  /** Systemische Gesamtnacharbeit (D1) — Cloudstatus des aktiven Abschlusses (`null` ohne aktiven Abschluss). */
  readonly activeClosureStatus?: AccountingPeriodRevisionStatus | null;
  /** Systemische Gesamtnacharbeit (D1) — Cloudstatus je Revision (`closure.id` → Status). */
  readonly revisionStatus?: Readonly<Record<string, AccountingPeriodRevisionStatus>>;
}
