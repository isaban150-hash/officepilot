/**
 * BANKABGLEICH-V1 BLOCK 2B — das Konto, zu dem ein Kontoauszug gehört.
 *
 * Bewusst **kein Bankkonto im Banking-Sinn**: keine Verbindung, kein Zugang,
 * kein Saldo, keine Bankleitzahl, kein Anbieter. Es ist nur die stabile
 * Identität, unter der importierte Auszüge aufbewahrt werden — gerade so viel,
 * dass zwei Konten nicht zu einem verschmelzen.
 *
 * Die Trennung von `id` und `displayName` ist der Kern: Die **Kennung** geht in
 * die Entdopplung ein, der **Name** nur in die Anzeige. Würde der Name die
 * Identität tragen, erzeugte ein späteres Umbenennen — „Sparkasse" zu
 * „Geschäftskonto Sparkasse" — beim nächsten Import schlagartig lauter
 * Dubletten. Mit einer stabilen Kennung darf der Name sich beliebig ändern.
 */

export interface BankAccount {
  /** Stabil und unveränderlich. Diese Kennung steht in jeder Bankbewegung. */
  id: string;
  /** Was der Nutzer liest und frei ändern darf. */
  displayName: string;
  /**
   * Die Kontokennung aus der Datei (Spalte „Auftragskonto"), normalisiert —
   * oder leer, wenn die Bank sie nicht mitliefert.
   *
   * Dient ausschliesslich dazu, einen späteren Auszug **automatisch** demselben
   * Konto zuzuordnen. Niemand muss sie eintippen.
   */
  identifier: string;
  createdAt: string;
  sync?: import('./sync').SyncMeta;
}
