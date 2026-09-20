/**
 * DOKUMENTVERSTAENDNIS-01C — woher der Volltext eines Schreibens kommt.
 *
 * Der Anlass war eine Überraschung bei der Abnahme: Der Verstehen-Bereich blieb
 * leer. Grund ist, dass ein **gespeicherter** Eingangsposten den Volltext nicht
 * mit sich führt. In `recognizedData` stehen danach nur noch die herausgelösten
 * Felder (Absender, Betrag, Frist) — der Fliesstext, aus dem 01B seine
 * Bedeutung liest, ist dort weg.
 *
 * Er ist aber nicht verloren: Die Analyse legt ihn im `DocumentWorkResult` zum
 * selben Eingangsposten ab. Dieser Dienst holt ihn von dort.
 *
 * Bewusst **kein** Eingriff in Persistenz oder Synchronisation: Kein neues Feld
 * am `InboxItem`, keine grösseren Nutzlasten, keine Migration. Gelesen wird nur,
 * was ohnehin schon gespeichert ist.
 */
import type { InboxItem } from '../../types/models';
import { getInboxExtractedDocumentText } from '../inboxDocumentText';
import {
  getDocumentWorkResult,
  getDocumentWorkResultStoreSnapshot,
} from '../documentWorkResultStoreService';

function ausRecognizedData(daten: Record<string, string> | undefined): string {
  if (!daten) return '';
  return (daten._extractedText ?? daten._vertragstext ?? daten.Vertragstext ?? '').trim();
}

/**
 * Der Volltext zu einem Eingangsposten — aus der nächstbesten Quelle.
 *
 * Zuerst der Posten selbst (frisch aus dem Hochladen, da steht der Text noch
 * daran), danach der gespeicherte Arbeitsstand der Analyse. Findet sich nichts,
 * bleibt es beim leeren Text, und der Verstehen-Bereich zeigt sich gar nicht.
 */
export function resolveInboxDocumentText(
  item: InboxItem,
  /**
   * Der auf der Seite ohnehin vorhandene Arbeitsstand. Er entsteht dort aus dem
   * wiederhergestellten `DocumentWorkResult` und trägt den Volltext bereits in
   * sich — die sicherste Quelle, weil sie keine zweite Ablagesuche braucht.
   */
  workflow?: { classification?: { recognizedData?: Record<string, string> } | null } | null,
): string {
  const direkt = getInboxExtractedDocumentText(item);
  if (direkt.trim()) return direkt;

  const ausWorkflow = ausRecognizedData(workflow?.classification?.recognizedData ?? undefined);
  if (ausWorkflow) return ausWorkflow;

  /*
   * Ohne zusätzliche Arbeitsbereichsprüfung: Der geladene Bestand stammt
   * bereits aus dem Speicher des geöffneten Arbeitsbereichs — der Schlüssel
   * enthält ihn. Eine zweite Prüfung gegen eine abweichend ermittelte Kennung
   * lieferte hier `null` und liess den Verstehen-Bereich leer.
   */
  const arbeitsstand =
    getDocumentWorkResult(item.id) ??
    getDocumentWorkResultStoreSnapshot().find((eintrag) => eintrag.inboxItemId === item.id) ??
    null;
  if (!arbeitsstand) return '';

  const ausAnalyse = ausRecognizedData(
    arbeitsstand.workflowDecision?.classification?.recognizedData,
  );
  if (ausAnalyse) return ausAnalyse;

  return ausRecognizedData(
    (arbeitsstand as { recognizedData?: Record<string, string> }).recognizedData,
  );
}
