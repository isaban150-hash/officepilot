/**
 * E-RECHNUNG-04E3 — eine Beschreibung für Papier und Datensatz.
 *
 * ## Der Befund aus 04E2
 *
 * Der Pauschalabschlag führt fachlich keine Positionen. Beide Seiten erzeugen
 * deshalb eine Zeile, und jede beschriftete sie bisher selbst:
 *
 *   sichtbares PDF   „Pauschale Abschlagszahlung gemäß Baufortschritt"
 *   kanonisch / XML  „Abschlag (Pauschale)"
 *
 * Für die XRechnung ist das folgenlos — sie ist ein eigenständiger Datensatz
 * und wird nicht neben einem PDF gelesen. Für ZUGFeRD ist es ein Mangel: Dort
 * liegen beide Darstellungen **in derselben Datei**, der maschinenlesbare Teil
 * ist fachlich führend, und ein Empfänger, der nachschlägt, fände zwei
 * Beschreibungen desselben Postens.
 *
 * ## Warum das Papier gewinnt
 *
 * Übernommen wird die **Formulierung des sichtbaren Belegs**, nicht die
 * kanonische. Drei Gründe:
 *
 *  - Ein Mensch prüft den PDF-Teil. Was er dort liest, muss der Datensatz
 *    bestätigen — nicht umgekehrt.
 *  - Das sichtbare Rechnungsdokument darf sich nicht ändern; sein Snapshot ist
 *    geschützt, und ein Betrieb soll seinen Beleg wiedererkennen.
 *  - „Pauschale Abschlagszahlung gemäß Baufortschritt" sagt einem Empfänger
 *    mehr als „Abschlag (Pauschale)".
 *
 * ## Was ausdrücklich unberührt bleibt
 *
 * Diese Umschrift geschieht **nur im ZUGFeRD-Pfad**. Das kanonische Modell,
 * die XRechnung-Ausgabe, ihre Goldfiles und das normale Rechnungs-PDF bleiben
 * Byte für Byte, wie sie waren. Verändert wird kein Geldbetrag, keine Menge,
 * keine Einheit und kein Steuerwert — ausschliesslich der Text einer Zeile,
 * die ohnehin auf beiden Seiten erzeugt und nicht vom Betrieb eingegeben wird.
 *
 * Weil Renderer und Gleichheitsprüfung dieselbe Funktion benutzen, braucht die
 * Prüfung für die Beschreibung **keine Ausnahme mehr**.
 */
import { FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION } from '../../invoiceCalculationMode';
import type { CanonicalLine } from '../canonicalEInvoice';

/**
 * Die Beschreibung, die eine Zeile im ZUGFeRD-Dokument trägt — im XML wie im
 * sichtbaren Teil.
 *
 * Für jede echte, vom Betrieb eingegebene Position ist das unverändert ihr
 * eigener Text. Nur die eine erzeugte Zeile des Pauschalabschlags bekommt die
 * Formulierung des Papiers.
 */
export function zugferdLineDescription(line: CanonicalLine): string {
  return line.synthetic ? FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION : line.description;
}
