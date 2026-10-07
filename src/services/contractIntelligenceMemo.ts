/**
 * CLOUD-SYNC S4 — Nacharbeit 2: gemeinsame, rein abgeleitete Ablage der
 * Vertragsintelligenz eines Eingangs.
 *
 * Die Vertragsintelligenz eines Eingangs (`analyzeContractIntelligenceFromInbox`)
 * ist eine reine Funktion genau vier Werte:
 *  - des wirksamen Dokumenttexts (`getInboxExtractedDocumentText`: Hauptseiten,
 *    sonst `_extractedText` / `_vertragstext` / `Vertragstext`),
 *  - des Seiten-JSON (`_pageTexts`),
 *  - der Dokumentart (`classifiedKind`, Zulassungs-Gate),
 *  - der eigenen Firma (Anlagen- und Briefkopfregeln).
 * Uhr, Sprache, Workspace, Vorgang und Kennung des Eingangs gehen nicht ein.
 *
 * Jede reguläre Analyse legt ihr Ergebnis hier ab. Wer dieselben Verträge
 * wiederholt braucht — die Gedächtnis-Projektion bei jedem Speichern —, liest
 * hier und lässt nur analysieren, wenn es für genau diese Eingaben noch kein
 * Ergebnis gibt. Ein Treffer gilt nur bei Gleichheit aller vier Eingaben: Der
 * Schlüssel ist nur ein Wegweiser, verglichen wird immer der volle Inhalt. Ein
 * Ergebnis zu einer geänderten Grundlage ist damit ausgeschlossen.
 *
 * Keine Wahrheit: nur im Arbeitsspeicher, nie gespeichert, nie gesendet, nach
 * jedem Neuladen leer. Abgelegt und herausgegeben wird je eine Kopie, damit
 * kein Aufrufer das gemeinsame Ergebnis verändern kann.
 */
import type { ContractIntelligenceResult } from '../types/documentIntelligence';
import type { ClassifiedDocumentKind, InboxItem } from '../types/models';
import { getCompanyProfile } from './companyProfileService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';

export type ContractIntelligenceInputs = {
  ownCompanyName: string;
  classifiedKind: ClassifiedDocumentKind | undefined;
  recognizedText: string;
  pageTextsRaw: string | undefined;
};

/** Die vollständigen Eingaben; ohne ausdrückliche Firma gilt — wie in der Analyse — das aktuelle Firmenprofil. */
export function contractIntelligenceInputsFromInbox(
  item: InboxItem,
  options: { ownCompanyName?: string } = {},
): ContractIntelligenceInputs {
  const ownCompanyName = options.ownCompanyName ?? getCompanyProfile().companyName;
  return {
    ownCompanyName,
    classifiedKind: item.classifiedKind,
    recognizedText: getInboxExtractedDocumentText(item, { ownCompanyName }),
    pageTextsRaw: item.recognizedData._pageTexts,
  };
}

/** Genug für die Verträge eines Betriebs; ältere Einträge fallen heraus und werden bei Bedarf neu analysiert. */
const ABLAGE_GROESSE = 128;
const ablage = new Map<string, { eingaben: ContractIntelligenceInputs; ergebnis: ContractIntelligenceResult | null }>();

function mische(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Länge als Trenner: („ab", „c") und („a", „bc") ergeben verschiedene Wegweiser.
  h ^= text.length;
  return Math.imul(h, 0x01000193);
}

/** FNV-1a über alle Eingaben — nur Wegweiser, nie Beweis. */
function wegweiser(eingaben: ContractIntelligenceInputs): string {
  let h = 0x811c9dc5;
  h = mische(h, eingaben.ownCompanyName);
  h = mische(h, eingaben.classifiedKind ?? '');
  h = mische(h, eingaben.recognizedText);
  h = mische(h, eingaben.pageTextsRaw ?? '');
  return `${(h >>> 0).toString(36)}:${eingaben.recognizedText.length}:${eingaben.pageTextsRaw?.length ?? -1}`;
}

function gleicheEingaben(a: ContractIntelligenceInputs, b: ContractIntelligenceInputs): boolean {
  return (
    a.ownCompanyName === b.ownCompanyName &&
    a.classifiedKind === b.classifiedKind &&
    a.recognizedText === b.recognizedText &&
    a.pageTextsRaw === b.pageTextsRaw
  );
}

/** Nach jeder regulären Analyse: das Ergebnis zu genau diesen Eingaben ablegen. */
export function rememberContractIntelligence(
  eingaben: ContractIntelligenceInputs,
  ergebnis: ContractIntelligenceResult | null,
): void {
  const schluessel = wegweiser(eingaben);
  ablage.delete(schluessel);
  ablage.set(schluessel, { eingaben, ergebnis: ergebnis ? structuredClone(ergebnis) : null });
  while (ablage.size > ABLAGE_GROESSE) {
    const aeltester = ablage.keys().next().value;
    if (aeltester === undefined) break;
    ablage.delete(aeltester);
  }
}

/**
 * Das abgelegte Ergebnis zu genau diesen Eingaben — `undefined`, wenn es keines
 * gibt. `{ result: null }` heisst: analysiert, aber keine zulässige
 * Vertragsintelligenz.
 */
export function recallContractIntelligence(
  eingaben: ContractIntelligenceInputs,
): { result: ContractIntelligenceResult | null } | undefined {
  const schluessel = wegweiser(eingaben);
  const eintrag = ablage.get(schluessel);
  if (!eintrag || !gleicheEingaben(eintrag.eingaben, eingaben)) return undefined;
  // Zuletzt genutzt: ans Ende, damit häufige Verträge nicht herausfallen.
  ablage.delete(schluessel);
  ablage.set(schluessel, eintrag);
  return { result: eintrag.ergebnis ? structuredClone(eintrag.ergebnis) : null };
}

/** Test-only: leere Ablage wie nach einem Neuladen. */
export function resetContractIntelligenceMemoForTests(): void {
  ablage.clear();
}
