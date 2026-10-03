/**
 * EINGANG-01D-2 Paritätsfix 1 — die eine Seitenwahrheit einer Gutschrift.
 *
 * Eine Gutschrift ist das Hauptdokument auf Seite 1; spätere Seiten
 * (angehängte oder zitierte Originalrechnung) bleiben Quelltext. Aufnahme,
 * Eingang und Archiv benutzen dafür dieselben Bausteine:
 *   - die kanonische Frist nach der 01D-1-Regel (`resolveCreditNoteActionDeadline`:
 *     nur Seite 1, nie `payment_due`, kein Rückgriff auf das Feld „Frist");
 *   - die Bedeutung mit den Fristen und Pflichten von Seite 1 (mehrere eigene
 *     Pflichten bleiben, Nacharbeit 4).
 * Gilt nur bei echter, gelesener Seitenstruktur (mindestens zwei Seiten) —
 * ohne Seitengrenzen wird keine erfunden.
 */
import { resolveCreditNoteActionDeadline } from '../documentClassificationService';
import { getCompanyProfileStoreSnapshot } from '../companyProfileService';
import { buildDocumentSemanticCore } from './documentSemanticCoreService';
import type { DocumentSemanticCore, SemanticDeadline, SemanticObligation } from '../../types/documentSemanticCore';
import type { InboxItem } from '../../types/models';

type PageText = { pageNumber: number; text: string };

/** Seitentexte aus `_pageTexts`; nur ein gültiges Seiten-JSON mit Text zählt. */
export function parsePageTextList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const pages = JSON.parse(raw) as Array<{ text?: unknown }>;
    if (!Array.isArray(pages)) return undefined;
    const texts = pages.map((page) => (typeof page?.text === 'string' ? page.text : ''));
    return texts.some((text) => text.trim()) ? texts : undefined;
  } catch {
    return undefined;
  }
}

/** Seite 1 einer Gutschrift mit echter Seitenstruktur — sonst `undefined`. */
export function creditNotePageOneText(
  classifiedKind: string | undefined,
  pages: readonly string[] | undefined,
): string | undefined {
  if (classifiedKind !== 'gutschrift' || !pages || pages.length < 2) return undefined;
  return pages[0]?.trim() || undefined;
}

/** Seite 1 eines Eingangselements, wenn es eine Gutschrift mit Seitenstruktur ist. */
export function creditNotePageOneTextOfItem(item: Pick<InboxItem, 'classifiedKind' | 'recognizedData'>): string | undefined {
  return creditNotePageOneText(item.classifiedKind, parsePageTextList(item.recognizedData?._pageTexts));
}

/** Kanonische Frist einer Gutschrift — dieselbe 01D-1-Regel für Aufnahme und Archiv. */
export function resolveCreditNoteDeadline(input: {
  recognizedText?: string;
  firstPage?: string;
}): ReturnType<typeof resolveCreditNoteActionDeadline> {
  return resolveCreditNoteActionDeadline({
    recognizedText: input.recognizedText,
    ...(input.firstPage ? { pageTexts: [{ pageNumber: 1, text: input.firstPage }] } : {}),
  });
}

/**
 * Aufnahme: Frist, Fristart und Aufgabenvorlage einer Gutschrift mit
 * Seitenstruktur folgen Seite 1. Die Vorschau-Klassifikation läuft bewusst
 * ohne Seitentexte (Speicherleistung); hier wird nur die Frist nachgezogen —
 * keine erneute Klassifikation, nichts für andere Dokumentarten.
 */
export function alignCreditNoteIntakeItemWithPageOne(
  item: InboxItem,
  input: { recognizedText?: string; pageTexts?: readonly PageText[] },
): InboxItem {
  const firstPage = creditNotePageOneText(
    item.classifiedKind,
    input.pageTexts?.map((page) => page.text),
  );
  if (!firstPage) return item;
  const { deadline, deadlineType } = resolveCreditNoteDeadline({ recognizedText: input.recognizedText, firstPage });
  const aligned: InboxItem = { ...item, deadline };
  if (deadline && deadlineType) aligned.deadlineType = deadlineType;
  else delete aligned.deadlineType;
  if (item.taskTemplate) aligned.taskTemplate = { ...item.taskTemplate, dueDate: deadline ?? undefined };
  return aligned;
}

/** Abgleich wie im Eingang: keine Zahlungsfrist, keine Forderung an uns. */
export function alignSemanticCoreWithCreditNote(
  core: DocumentSemanticCore | undefined,
  classifiedKind: string | undefined,
): DocumentSemanticCore | undefined {
  if (!core || classifiedKind !== 'gutschrift') return core;
  const { primaryActionDeadline, ...rest } = core;
  return {
    ...rest,
    ...(primaryActionDeadline && primaryActionDeadline.type !== 'payment_due' ? { primaryActionDeadline } : {}),
    deadlines: core.deadlines.filter((frist) => frist.type !== 'payment_due'),
    amounts: core.amounts.filter((betrag) => !betrag.isClaimAgainstUs),
  };
}

/**
 * Bedeutung einer Gutschrift mit Seitenstruktur: Fristen, Pflichten,
 * Primärfrist und Anliegen von Seite 1 (dieselbe Kern-Engine); die kanonische
 * Frist bleibt sichtbar, auch wenn sie nicht auf Seite 1 steht. Mehrere eigene
 * Pflichten von Seite 1 bleiben (Nacharbeit 4).
 */
export function projectCreditNoteCoreToPageOne(
  core: DocumentSemanticCore,
  pageOneText: string,
  canonicalDeadline: string | null | undefined,
): DocumentSemanticCore {
  const pageOne = alignSemanticCoreWithCreditNote(
    buildDocumentSemanticCore({ text: pageOneText, companyProfile: getCompanyProfileStoreSnapshot() ?? null }),
    'gutschrift',
  )!;
  const canonical = canonicalDeadline?.trim().slice(0, 10) || null;
  const onPageOne = (frist: SemanticDeadline) =>
    pageOne.deadlines.some((eigene) => eigene.type === frist.type && eigene.date === frist.date);
  const dutyOnPageOne = (pflicht: SemanticObligation) =>
    pageOne.obligations.some((eigene) => eigene.who === pflicht.who && eigene.byWhen === pflicht.byWhen && eigene.what === pflicht.what);
  const canonicalDeadlines = canonical
    ? core.deadlines.filter((frist) => frist.actionRequired && frist.date.slice(0, 10) === canonical && !onPageOne(frist))
    : [];
  const canonicalDuties = canonical
    ? core.obligations.filter(
        (pflicht) => pflicht.who === 'own_company' && pflicht.byWhen?.slice(0, 10) === canonical && !dutyOnPageOne(pflicht),
      )
    : [];

  const projected: DocumentSemanticCore = {
    ...core,
    deadlines: [...pageOne.deadlines, ...canonicalDeadlines],
    obligations: [...pageOne.obligations, ...canonicalDuties],
  };
  const primary = pageOne.primaryActionDeadline ?? canonicalDeadlines[0];
  if (primary) projected.primaryActionDeadline = primary;
  else delete projected.primaryActionDeadline;
  if (pageOne.purpose) projected.purpose = pageOne.purpose;
  else delete projected.purpose;
  return projected;
}
