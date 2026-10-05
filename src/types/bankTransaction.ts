/**
 * BANKABGLEICH-V1 BLOCK 2 — die dauerhaft gespeicherte Bankbewegung.
 *
 * Eine Bankbewegung ist ein **Nachweis**: Sie sagt, was auf einem Bankkonto
 * geschehen ist. Sie ist weder eine Zahlung noch ein Zahlungsstatus noch eine
 * Buchung. Deshalb trägt sie bewusst **kein** `invoiceId`, `expenseId`,
 * `paymentId`, keinen Abgleichstatus und keine Konfidenz — diese Felder
 * gehören zu einem späteren Block, und ein Feld, das heute leer bliebe, würde
 * den Eindruck erwecken, hier werde bereits abgeglichen.
 *
 * Gegenüber der Vorschau aus Block 1 kommen nur die Felder hinzu, die das
 * dauerhafte Aufbewahren wirklich braucht: woher die Bewegung stammt
 * (`accountKey`, `importId`, `fileName`), wann sie hereinkam (`importedAt`)
 * und was sie von einer anderen unterscheidet (`fingerprint`, `occurrence`).
 */

export interface BankTransaction {
  id: string;
  /**
   * Das Bankkonto, zu dem diese Bewegung gehört.
   *
   * Aus der Spalte „Auftragskonto" der Datei, sonst `''`. Der Schlüssel geht
   * in die Eindeutigkeit ein, damit dieselbe Bewegung auf **zwei
   * verschiedenen Konten** nicht als dieselbe gilt. Block 2 verwaltet keine
   * Konten; er merkt sich nur, was die Datei über das Konto verrät.
   */
  accountKey: string;
  /** Der Importvorgang, aus dem diese Bewegung stammt. */
  importId: string;
  fileName: string;
  importedAt: string;

  bookingDate: string;
  valueDate?: string;
  amountCents: number;
  currency?: string;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  bankReference?: string;

  /** Der normalisierte Fachinhalt — siehe `buildFingerprint`. */
  fingerprint: string;
  /**
   * Die wievielte Bewegung mit genau diesem Fingerabdruck auf diesem Konto.
   *
   * Zwei echte gleiche Abbuchungen am selben Tag gibt es wirklich. Ohne diese
   * Zählung wäre die zweite beim Speichern nicht von einer Wiederholung des
   * Imports zu unterscheiden — und eine davon ginge verloren.
   */
  occurrence: number;
  /** BLOCK 2B — Sync-Meta wie bei jeder synchronisierten Entitaet. */
  sync?: import('./sync').SyncMeta;
}

/** Was ein Import bewirkt hat — die Zahlen, die der Nutzer vorher und nachher liest. */
export interface BankImportOutcome {
  importId: string;
  fileName: string;
  /** Übernommen, weil noch nicht vorhanden. */
  added: number;
  /** Übergangen, weil bereits gespeichert — kein Fehler, der Normalfall. */
  alreadyPresent: number;
  /** Nicht angeboten, weil die Zeile nicht verstanden wurde. */
  skippedProblemRows: number;
}
