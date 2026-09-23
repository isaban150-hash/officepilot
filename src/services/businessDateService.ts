/**
 * RECHNUNGSBEREICH-03D — der Geschäftstag ist der Tag des Betriebs, nicht der
 * Tag in Greenwich.
 *
 * Realbefund aus der unabhängigen Abnahme: Am 23.09.2026 um 00:30 Ortszeit
 * trugen ein neu angelegter Auftrag, eine neue Rechnung und ein Storno den
 * 22.09.2026 — der Leistungszeitraum daneben den 23.09.2026. Ursache war
 * überall dieselbe Zeile:
 *
 *     new Date().toISOString().slice(0, 10)
 *
 * `toISOString` rechnet nach UTC um. Zwischen lokaler Mitternacht und
 * UTC-Mitternacht (in Deutschland ein bis zwei Stunden, im Sommer zwei) liegt
 * der UTC-Kalendertag deshalb einen Tag zurück. Für einen Betrieb, der um
 * halb eins noch eine Rechnung schreibt, ist das schlicht das falsche Datum.
 *
 * Hier steht deshalb die eine Stelle, die den **lokalen** Kalendertag bildet.
 * Sie rechnet nichts um: Jahr, Monat und Tag kommen aus derselben Zeitzone,
 * in der der Nutzer auf die Uhr sieht.
 *
 * Bewusst nicht angefasst: Fälligkeits- und Skontorechnung (`addCalendarDays`)
 * arbeiten auf der Zeichenkette `YYYY-MM-DD` und verschieben nichts — sie
 * werden allein dadurch richtig, dass ihr Ausgangstag jetzt stimmt.
 */

/** Der lokale Kalendertag als `YYYY-MM-DD` — das Geschäftsdatum. */
export function getBusinessDay(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) return '';
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Der lokale Kalendertag eines gespeicherten Zeitpunkts.
 *
 * Serverzeitstempel (z. B. `cancelled_at`) kommen als UTC zurück. Sie einfach
 * abzuschneiden zeigte dem Nutzer denselben Tag zu früh; hier wird der
 * Zeitpunkt in seine Ortszeit gelesen. Ein reines Datum (`YYYY-MM-DD`) bleibt
 * unverändert — es ist bereits ein Kalendertag und darf nicht umgerechnet werden.
 */

export function toBusinessDay(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 10);
  return getBusinessDay(parsed);
}

/**
 * RECHNUNGSBEREICH-03D2 — den alten UTC-Fehler in gespeicherten Entwürfen
 * heilen, ohne je eine bewusste Eingabe zu überschreiben.
 *
 * Entwürfe, die vor 03D zwischen lokaler Mitternacht und UTC-Mitternacht
 * entstanden sind, tragen den Vortag als Rechnungsdatum — und ein davon
 * abgeleitetes Zahlungsziel. Neue Entwürfe sind längst richtig; die alten
 * blieben es nicht, weil ein Rechnungsdatum zu Recht als Benutzereingabe gilt
 * und niemals stillschweigend angefasst wird.
 *
 * Deshalb wird hier **nicht** auf „heute" gesetzt, sondern nur ein eindeutiger
 * Fingerabdruck geheilt: Der Entwurf muss aus der Umstellungszeit stammen
 * (sein Erzeugungszeitpunkt fällt lokal auf einen anderen Kalendertag als in
 * UTC) **und** sein Rechnungsdatum muss exakt dem UTC-Tag dieses Zeitpunkts
 * entsprechen. Jeder andere Wert — auch ein Tag davor oder danach — ist eine
 * Entscheidung des Nutzers und bleibt.
 *
 * Das Zahlungsziel folgt nur, wenn es nachweislich automatisch aus dem
 * falschen Datum entstanden ist (exakt Rechnungsdatum + Standardzahlungsziel).
 * Ein selbst gesetztes Datum passt nicht auf diese Rechnung und bleibt stehen;
 * ein leeres Feld (eigene Auftragskonditionen, 02C2) bleibt leer.
 */
export interface LegacyBusinessDateRepairInput {
  issueDate: string;
  paymentDueDate: string;
  /** Erzeugungszeitpunkt des gespeicherten Entwurfs (ISO, UTC). */
  createdAt: string;
  /** Standardzahlungsziel des Betriebs in Tagen. */
  defaultPaymentDays: number;
}

export interface LegacyBusinessDateRepairResult {
  issueDate: string;
  paymentDueDate: string;
  repaired: boolean;
}

export function repairLegacyUtcBusinessDates(
  input: LegacyBusinessDateRepairInput,
  addDays: (base: string, days: number) => string,
): LegacyBusinessDateRepairResult {
  const unveraendert: LegacyBusinessDateRepairResult = {
    issueDate: input.issueDate,
    paymentDueDate: input.paymentDueDate,
    repaired: false,
  };

  const erzeugt = new Date(input.createdAt);
  if (Number.isNaN(erzeugt.getTime())) return unveraendert;

  const utcTag = erzeugt.toISOString().slice(0, 10);
  const geschaeftstag = getBusinessDay(erzeugt);
  // Tagsüber sind beide gleich — dann gibt es nichts zu heilen.
  if (!geschaeftstag || utcTag === geschaeftstag) return unveraendert;
  // Nur der exakte Fingerabdruck des alten Defaults wird angefasst.
  if (input.issueDate !== utcTag) return unveraendert;

  const abgeleitet =
    Number.isFinite(input.defaultPaymentDays) && input.paymentDueDate
      ? addDays(utcTag, input.defaultPaymentDays) === input.paymentDueDate
      : false;

  return {
    issueDate: geschaeftstag,
    paymentDueDate: abgeleitet ? addDays(geschaeftstag, input.defaultPaymentDays) : input.paymentDueDate,
    repaired: true,
  };
}
