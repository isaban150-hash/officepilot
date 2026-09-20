/**
 * DOKUMENT-ASSISTENT-01H1 — wie alt darf eine fachliche Aussage sein?
 *
 * Diese Frage muss beantwortet sein, **bevor** die erste Fachaussage einen
 * Benutzer erreicht. Eine Steuerregel von vorgestern als geltend auszugeben
 * ist der teuerste Fehler, den dieses Produkt machen kann — teurer als gar
 * keine Antwort.
 *
 * Die Fristen stehen deshalb **hier** und nirgends sonst. Stünde an jedem
 * Eintrag eine eigene Zahl, hätte nach einem Jahr jeder Eintrag seine eigene
 * Willkür, und niemand könnte mehr sagen, welche Regel gilt.
 *
 * Der Zustand wird **gerechnet, nicht gespeichert**: Ein gespeichertes
 * „aktuell" ist am Tag nach dem Speichern bereits eine Behauptung.
 */
import type {
  KnowledgeFreshness,
  KnowledgeFreshnessResult,
  KnowledgeSource,
  KnowledgeStatement,
  KnowledgeTopicClass,
} from '../../types/domainKnowledge';

/**
 * Höchstalter des Prüfstands je Wissensklasse, in Tagen.
 *
 * Die Begründung steckt in der Sache: Was ein Aufmass ist, ändert sich nicht;
 * ein Schwellenwert oder ein Behördenformular kann sich zum Jahreswechsel
 * ändern. Die Zahlen sind bewusst streng — im Zweifel lieber eine Aussage zu
 * oft prüfen als einmal zu selten.
 */
const MAX_REVIEW_AGE_DAYS: Record<KnowledgeTopicClass, number> = {
  stable_definition: 1095,
  legal_rule: 365,
  authority_process: 270,
  tax_rule: 180,
  form_or_application: 180,
  threshold_or_amount: 180,
};

export function maxReviewAgeDays(topicClass: KnowledgeTopicClass): number {
  return MAX_REVIEW_AGE_DAYS[topicClass];
}

/**
 * Welche Quellen als belegt gelten.
 *
 * `curated_secondary` ist dabei kein Notbehelf: Ein von OfficeTakt selbst
 * geprüfter Eintrag über einen Fachbegriff ist belegt — er nennt nur uns als
 * Herausgeber und behauptet keine Behördenautorität.
 */
const VERIFIED_TRUST = new Set<KnowledgeSource['trust']>([
  'official_primary',
  'official_guidance',
  'professional_body',
  'curated_secondary',
]);

function istTag(wert: string | undefined): boolean {
  return Boolean(wert && /^\d{4}-\d{2}-\d{2}$/.test(wert) && !Number.isNaN(Date.parse(wert)));
}

function tageZwischen(vonIso: string, bisIso: string): number {
  const von = Date.parse(`${vonIso}T00:00:00.000Z`);
  const bis = Date.parse(`${bisIso}T00:00:00.000Z`);
  return Math.floor((bis - von) / 86_400_000);
}

/**
 * Der Zustand einer Aussage zum Stichtag.
 *
 * Die Reihenfolge der Prüfungen ist Teil der Zusage und darf nicht umgestellt
 * werden:
 *
 *   1. **unverified** — ohne belegte Quelle oder ohne saubere Datumsangaben
 *      ist alles Weitere gegenstandslos. Was wir nicht einordnen können,
 *      dürfen wir nicht verwenden.
 *   2. **future** — gilt noch nicht. Eine Regel, die erst nächstes Jahr in
 *      Kraft tritt, ist heute keine geltende Regel, und ihr Prüfstand spielt
 *      dafür keine Rolle.
 *   3. **expired** — galt einmal, gilt nicht mehr.
 *   4. **stale** — gilt, aber wir haben zu lange nicht nachgesehen.
 *   5. **current** — gilt und ist frisch geprüft.
 *
 * `asOf` wird immer übergeben. Eine Funktion, die heimlich die Uhr liest,
 * lässt sich nicht prüfen.
 */
export function evaluateKnowledgeFreshness(
  statement: KnowledgeStatement,
  source: KnowledgeSource | undefined,
  asOf: string,
): KnowledgeFreshnessResult {
  if (!istTag(asOf)) {
    return unbrauchbar('unverified', 'Der Stichtag ist kein gültiges Datum.');
  }

  /* 1 — Belegbarkeit. */
  if (!source) {
    return unbrauchbar('unverified', 'Zu dieser Aussage ist keine Quelle hinterlegt.');
  }
  if (!VERIFIED_TRUST.has(source.trust)) {
    return unbrauchbar('unverified', 'Die Quelle ist fachlich nicht eingeordnet.');
  }
  if (!istTag(statement.validFrom) || !istTag(statement.reviewedAt)) {
    return unbrauchbar('unverified', 'Gültigkeit oder Prüfstand fehlen oder sind unbrauchbar.');
  }
  if (statement.validUntil && !istTag(statement.validUntil)) {
    return unbrauchbar('unverified', 'Das Ende der Gültigkeit ist unbrauchbar.');
  }

  /* 2 — gilt noch nicht. */
  if (tageZwischen(asOf, statement.validFrom) > 0) {
    return {
      freshness: 'future',
      reason: `Gilt erst ab ${statement.validFrom}.`,
      usableAsCurrent: false,
    };
  }

  /* 3 — gilt nicht mehr. */
  if (statement.validUntil && tageZwischen(statement.validUntil, asOf) > 0) {
    return {
      freshness: 'expired',
      reason: `Galt bis ${statement.validUntil}.`,
      usableAsCurrent: false,
    };
  }

  /* 4 — zu lange nicht geprüft. */
  const alter = tageZwischen(statement.reviewedAt, asOf);
  const grenze = maxReviewAgeDays(statement.topicClass);
  if (alter > grenze) {
    return {
      freshness: 'stale',
      reason: `Zuletzt am ${statement.reviewedAt} geprüft; für diese Art von Wissen sind höchstens ${grenze} Tage vorgesehen.`,
      usableAsCurrent: false,
      reviewAgeDays: alter,
    };
  }

  /* 5 — gilt und ist frisch. */
  return {
    freshness: 'current',
    reason: `Gültig und zuletzt am ${statement.reviewedAt} geprüft.`,
    usableAsCurrent: true,
    reviewAgeDays: alter,
  };
}

function unbrauchbar(freshness: KnowledgeFreshness, reason: string): KnowledgeFreshnessResult {
  return { freshness, reason, usableAsCurrent: false };
}

/**
 * Was mit einer Aussage je Zustand geschehen darf.
 *
 * Steht hier und nicht erst im Oberflächenblock, damit 01H3 dieselbe
 * Entscheidung nicht ein zweites Mal — und womöglich anders — trifft.
 */
export type KnowledgeUsage =
  /** Darf als belegtes, geltendes Fachwissen verwendet werden. */
  | 'use_as_current'
  /** Darf nur mit dem Hinweis „gilt ab …" verwendet werden. */
  | 'mention_as_future'
  /** Darf nicht als geltend dargestellt werden; der Stand ist zu nennen. */
  | 'mention_with_caveat'
  /** Darf gar nicht als Fachwissen dienen. */
  | 'do_not_use';

export function resolveKnowledgeUsage(freshness: KnowledgeFreshness): KnowledgeUsage {
  switch (freshness) {
    case 'current':
      return 'use_as_current';
    case 'future':
      return 'mention_as_future';
    case 'expired':
    case 'stale':
      return 'mention_with_caveat';
    case 'unverified':
    default:
      return 'do_not_use';
  }
}
