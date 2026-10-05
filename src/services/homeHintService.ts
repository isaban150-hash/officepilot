import type { TranslationKey } from '../i18n';
import { buildProactiveHints } from './brain/companyProactiveHintsService';
import { getCompanySession } from './brain/companySessionService';
import {
  buildHomeHintId,
  isHomeHintVisible,
} from './homeHintDismissalService';
import { getOpenDocumentLifecycleItems } from './documentLifecycleService';
import { RECEIPT_CANDIDATE_PROFILES } from '../types/documentCandidateProfiles';
import { getAllInvoiceOverview } from './invoiceOverviewService';
import { getSteuerberaterMonthOverview } from './steuerberaterOverviewService';
import { getTodayIso } from './taskNormalize';

export type HomeHintSeverity = 'critical' | 'warning' | 'info';

export interface HomeHint {
  id: string;
  severity: HomeHintSeverity;
  messageKey: TranslationKey;
  params?: Record<string, string | number>;
  route?: string;
}

function severityForMessageKey(messageKey: string): HomeHintSeverity {
  if (
    messageKey.includes('risk') ||
    messageKey.includes('overdue') ||
    messageKey.includes('payment') ||
    messageKey.includes('mahnung')
  ) {
    return 'critical';
  }
  if (
    messageKey.includes('recommend') ||
    messageKey.includes('steuerberater') ||
    messageKey.includes('material') ||
    messageKey.includes('assign')
  ) {
    return 'warning';
  }
  return 'info';
}

function addHint(
  hints: HomeHint[],
  seen: Set<string>,
  messageKey: TranslationKey,
  params?: Record<string, string | number>,
  route?: string,
  severity?: HomeHintSeverity,
): void {
  const id = buildHomeHintId(messageKey, params);
  if (seen.has(id) || !isHomeHintVisible(id)) return;
  seen.add(id);
  hints.push({
    id,
    severity: severity ?? severityForMessageKey(messageKey),
    messageKey,
    params,
    route,
  });
}

/**
 * HEUTE-V2 — offene Dokumentvorgänge als Arbeit auf der Startseite.
 *
 * Der Lebenszyklus eines Dokuments kennt seit jeher vier offene Gründe:
 * Antwort offen, Original abheften, Frist offen, Nachweis fehlt. Gelesen hat
 * sie bisher nur die Suche. Wer die Dokumentenliste nicht von sich aus
 * durchgeht, erfuhr von einer Behördenfrist nichts — und genau das ist der
 * teuerste Bürofehler.
 *
 * Bewusst **keine zweite Fristenengine**: Gelesen wird ausschliesslich
 * getOpenDocumentLifecycleItems, samt dessen Aufmerksamkeitsfenster von
 * 30 Tagen und dessen fertigem Handlungssatz. Hier entsteht nur die
 * Zuordnung „offener Grund → Hinweis mit Dringlichkeit und Ziel".
 *
 * task_open bleibt ausdrücklich aussen vor: Offene Aufgaben hat die
 * Startseite bereits über die Aufgabenwelt; sie hier zu wiederholen hiesse,
 * denselben Arbeitsauftrag zweimal zu stellen.
 */
const LIFECYCLE_REASON_KEYS: Record<string, TranslationKey> = {
  reply_open: 'hints.documentReplyOpen',
  proof_missing: 'hints.documentProofMissing',
  file_original: 'hints.documentFileOriginal',
};

/** Höchstens so viele Dokumenthinweise — die Startseite soll nicht geflutet werden. */
const MAX_LIFECYCLE_HINTS = 3;

/**
 * Sichtbare Abnahme — der Hinweis las sich als „Original abheften: Gerade
 * erfasst: Tankbeleg – ARAL.": zwei Doppelpunkte, und der Satz begann mit dem
 * Erfassungszustand statt mit dem Dokument. `Gerade erfasst:` ist der
 * Platzhaltertitel, den documentClassificationService frisch eingelesenen
 * Belegen voranstellt — kein Teil des Dokumentnamens.
 *
 * Bewusst **dasselbe Muster wie orderPositionFactory**, nicht eine zweite
 * eigene Variante: Wo im Haus bereits entschieden ist, wie dieser Platzhalter
 * abgestreift wird, soll die Startseite nicht abweichen.
 */
function lesbarerTitel(title: string): string {
  return title.replace(/^Gerade erfasst:\s*/i, '').trim();
}

/**
 * Dokumentarten, deren „Frist" in Wahrheit ein Zahlungsziel ist.
 *
 * Sichtbare Abnahme — nachdem die Fristerkennung wieder griff, verdrängten
 * „Eingangsrechnung" und „Mahnung" den bestehenden Sammelhinweis
 * „3 Rechnungen überfällig" von der Startseite. Dasselbe Geld wäre damit
 * dreifach gemeldet: in Finanzen, im Sammelzähler und noch einmal als
 * Dokumentfrist — genau die Doppelmeldung, die dieser Block vermeiden soll.
 *
 * Bewusst aus den bestehenden `RECEIPT_CANDIDATE_PROFILES` abgeleitet statt
 * aus einer handgepflegten Liste: Kommt eine Belegart hinzu, ist sie ohne
 * Zutun mit erfasst. Es entfällt **nur der Fristhinweis**; ein fehlender
 * Nachweis oder ein nicht abgeheftetes Original bleibt sichtbar.
 */
const ZAHLUNGSARTEN = new Set(
  RECEIPT_CANDIDATE_PROFILES.filter(
    (profil) => profil.family === 'eingangsrechnung' || profil.family === 'zahlung',
  ).map((profil) => String(profil.kind)),
);

function tageBis(isoDate: string, todayIso: string): number {
  const heute = new Date(todayIso.slice(0, 10) + 'T12:00:00');
  const ziel = new Date(isoDate.slice(0, 10) + 'T12:00:00');
  return Math.round((ziel.getTime() - heute.getTime()) / 86400000);
}

/**
 * Die Dringlichkeit einer Frist — vier nachvollziehbare Stufen statt einer
 * Punktrechnung. Eine spätere Frist verschwindet nicht; sie steht nur hinten.
 */
function fristHinweis(tage: number): { key: TranslationKey; severity: HomeHintSeverity } {
  if (tage < 0) return { key: 'hints.documentDeadlineOverdue', severity: 'critical' };
  if (tage === 0) return { key: 'hints.documentDeadlineToday', severity: 'critical' };
  if (tage <= 3) return { key: 'hints.documentDeadlineSoon', severity: 'warning' };
  return { key: 'hints.documentDeadlineLater', severity: 'info' };
}

/**
 * Ein Hinweis je Dokument, nicht je offenem Grund: Ein Beleg, der zugleich
 * eine Frist trägt und einen Nachweis vermissen lässt, ist ein Arbeitsgang.
 * Die Frist gewinnt, weil sie die einzige mit einem Verfallsdatum ist.
 */
function lifecycleHints(hints: HomeHint[], seen: Set<string>, todayIso: string): void {
  const kandidaten: Array<{ rang: number; apply: () => void }> = [];

  for (const view of getOpenDocumentLifecycleItems(todayIso)) {
    const gruende = view.openReasons.filter((reason) => reason !== 'task_open');
    if (gruende.length === 0) continue;

    const titel = lesbarerTitel(view.title);
    if (!titel) continue;

    const istZahlungsziel = view.kind ? ZAHLUNGSARTEN.has(view.kind) : false;

    if (gruende.includes('deadline_open') && view.deadline && !istZahlungsziel) {
      const tage = tageBis(view.deadline, todayIso);
      const { key, severity } = fristHinweis(tage);
      kandidaten.push({
        /* Je näher die Frist, desto weiter vorn — überfällig zuerst. */
        rang: tage,
        apply: () => addHint(hints, seen, key, { title: titel }, view.route, severity),
      });
      continue;
    }

    const reason = gruende.find((item) => LIFECYCLE_REASON_KEYS[item]);
    if (!reason) continue;
    kandidaten.push({
      /* Hinter jeder Frist, aber in stabiler Reihenfolge. */
      rang: 1000,
      apply: () =>
        addHint(
          hints,
          seen,
          LIFECYCLE_REASON_KEYS[reason]!,
          { title: titel },
          view.route,
          reason === 'file_original' ? 'info' : 'warning',
        ),
    });
  }

  kandidaten.sort((a, b) => a.rang - b.rang);
  for (const kandidat of kandidaten.slice(0, MAX_LIFECYCLE_HINTS)) kandidat.apply();
}
export function buildHomeHints(now: Date | string = new Date()): HomeHint[] {
  const hints: HomeHint[] = [];
  const seen = new Set<string>();
  const todayIso = getTodayIso(now);
  const tomorrow = new Date(`${todayIso.slice(0, 10)}T12:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  /*
   * Zuerst die Dokumentvorgänge: buildHomeHints schneidet am Ende auf drei
   * ab, und eine überfällige Behördenfrist darf nicht hinter einem
   * Monatsmappenhinweis herausfallen. Die endgültige Reihenfolge bestimmt
   * danach ohnehin deskIntelligenceService.
   */
  lifecycleHints(hints, seen, todayIso);

  for (const proactive of buildProactiveHints(getCompanySession())) {
    addHint(
      hints,
      seen,
      proactive.messageKey as TranslationKey,
      proactive.params,
    );
  }

  for (const item of getAllInvoiceOverview(todayIso)) {
    if (item.paymentSummary.status !== 'offen' && item.paymentSummary.status !== 'teilbezahlt') {
      continue;
    }
    const due = item.invoice.paymentDueDate?.slice(0, 10);
    if (due === tomorrowIso) {
      addHint(
        hints,
        seen,
        'hints.invoiceDueTomorrow',
        { customer: item.customer, number: item.invoice.number },
        '/rechnungen/offen',
        'critical',
      );
    }
  }

  const steuerMonth = getSteuerberaterMonthOverview(now);
  if (steuerMonth.isComplete) {
    addHint(
      hints,
      seen,
      'hints.steuerberaterReady',
      { month: steuerMonth.monthLabel },
      '/steuerberater',
      'warning',
    );
  } else if (steuerMonth.completenessPercent >= 80 && steuerMonth.documentCount > 0) {
    addHint(
      hints,
      seen,
      'hints.steuerberaterAlmost',
      { month: steuerMonth.monthLabel },
      '/steuerberater',
      'warning',
    );
  } else if (steuerMonth.missingCount > 0) {
    addHint(
      hints,
      seen,
      'hints.steuerberaterMissing',
      { count: steuerMonth.missingCount, month: steuerMonth.monthLabel },
      '/steuerberater',
      'warning',
    );
  }

  return hints.slice(0, 3);
}
