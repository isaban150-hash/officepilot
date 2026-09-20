/**
 * DOKUMENT-ASSISTENT-01H1 — belegtes Fachwissen mit Quelle und Stand.
 *
 * **Abgrenzung zuerst, weil hier zwei Dinge gleich heissen und es nicht sind:**
 *
 *   `KnowledgeFact` (types/knowledge.ts) ist das **betriebliche Gedächtnis**:
 *   „Dieser Kunde will immer vormittags beliefert werden." Es gehört einem
 *   Arbeitsbereich, wird vom Benutzer bestätigt und synchronisiert.
 *
 *   `KnowledgeStatement` hier ist **allgemeines Fachwissen**: „Eine
 *   Abschlagsrechnung ist …". Es gehört niemandem, wird nicht synchronisiert
 *   und stammt aus einer benennbaren Quelle.
 *
 * Die beiden dürfen sich nie vermischen. Deshalb ein eigener Namensraum statt
 * einer Erweiterung des vorhandenen Typs.
 *
 * **Warum Quelle und Aussage getrennt sind:** Eine Quelle ist ein Dokument
 * oder eine Stelle — ein Gesetzestext, ein Merkblatt, ein Register. Sie trägt
 * viele Aussagen. Würde beides in einem Objekt stecken, wäre entweder die
 * Herkunft bei jeder Aussage kopiert (und driftete auseinander), oder eine
 * ganze Webseite wäre ein einziger Eintrag — und nichts davon liesse sich
 * einzeln zitieren. Zitierbar muss aber die **einzelne Aussage** sein, sonst
 * heisst es später „diese Antwort hat drei Quellen" statt „diese Tatsache
 * stammt von dort".
 */

/**
 * Wie verlässlich eine Quelle fachlich ist.
 *
 * `official_primary` — der Rechts- oder Verfahrenstext selbst.
 * `official_guidance` — eine Behörde erläutert ihn (Merkblatt, Schreiben).
 * `professional_body` — Kammer, Verband, Berufsorganisation.
 * `curated_secondary` — von OfficeTakt selbst zusammengetragen und geprüft.
 *
 * Blogs, Foren und maschinell erzeugte Texte sind bewusst **keine** Kategorie:
 * Was sich nicht einordnen lässt, ist keine Quelle.
 */
export type KnowledgeSourceTrust =
  | 'official_primary'
  | 'official_guidance'
  | 'professional_body'
  | 'curated_secondary';

/** Welcher Art die Quelle ist — für die Anzeige und die Einordnung. */
export type KnowledgeSourceKind =
  | 'statute'
  | 'authority_publication'
  | 'form_or_procedure'
  | 'professional_guidance'
  | 'internal_curated';

/**
 * Wofür eine Aussage gilt.
 *
 * `country` genügt für fast alles; `region` kommt nur dazu, wo es fachlich
 * wirklich einen Unterschied macht. Der Typ bleibt trotzdem allgemein, damit
 * er später nicht für jeden zweiten Fall aufgebohrt werden muss.
 */
export interface KnowledgeJurisdiction {
  /** ISO-3166-1 alpha-2, zunächst immer 'DE'. */
  country: string;
  /** Bundesland o. Ä., nur wenn die Aussage davon abhängt. */
  region?: string;
}

export interface KnowledgeSource {
  id: string;
  title: string;
  /** Wer die Quelle herausgibt — die Stelle, nicht die Person. */
  publisher: string;
  /**
   * Stabile Adresse oder Kennung.
   *
   * Optional, weil ein kuratierter Eintrag ohne Netzadresse auskommt. Eine
   * URL wird **nie** erfunden: Lieber keine als eine erfundene, denn eine
   * erfundene Quelle ist schlimmer als gar keine.
   */
  url?: string;
  identifier?: string;
  kind: KnowledgeSourceKind;
  trust: KnowledgeSourceTrust;
  jurisdiction: KnowledgeJurisdiction;
}

/**
 * Die fachliche Einordnung einer Aussage — sie bestimmt, wie schnell sie
 * veraltet. Bewusst wenige Klassen: Eine feinere Taxonomie würde heute mehr
 * Ordnung vortäuschen, als wir haben.
 */
export type KnowledgeTopicClass =
  | 'stable_definition'
  | 'tax_rule'
  | 'legal_rule'
  | 'authority_process'
  | 'threshold_or_amount'
  | 'form_or_application';

export interface KnowledgeStatement {
  id: string;
  /** Das Sachthema, nach dem später gesucht wird — z. B. 'abschlagsrechnung'. */
  topic: string;
  topicClass: KnowledgeTopicClass;
  /** Genau **eine** fachliche Aussage. Kein Absatz, kein Merkblatt. */
  statement: string;
  sourceId: string;
  /** Ab wann die Aussage gilt (ISO-Tag). */
  validFrom: string;
  /** Bis wann sie gilt, falls absehbar. */
  validUntil?: string;
  /** Wann ein Mensch diesen Eintrag zuletzt gegen die Quelle geprüft hat. */
  reviewedAt: string;
  /** Wann der Inhalt von einer externen Quelle geholt wurde — erst ab 01H4. */
  retrievedAt?: string;
  /** Weitere Bezeichnungen, unter denen dieselbe Sache gesucht wird. */
  aliases?: string[];
}

/**
 * Der Zustand einer Aussage zu einem Stichtag.
 *
 * Bewusst **nicht** am Eintrag gespeichert: Er ergibt sich vollständig aus
 * Datum, Prüfstand und Richtlinie. Gespeichert wäre er am Tag nach dem
 * Speichern schon wieder eine Behauptung.
 */
export type KnowledgeFreshness =
  | 'current'
  | 'future'
  | 'expired'
  | 'stale'
  | 'unverified';

export interface KnowledgeFreshnessResult {
  freshness: KnowledgeFreshness;
  /** Warum — in Klartext, für Prüfung und spätere Anzeige. */
  reason: string;
  /** Darf die Aussage als belegtes, aktuell geltendes Fachwissen dienen? */
  usableAsCurrent: boolean;
  /** Alter des Prüfstands in Tagen, sofern berechenbar. */
  reviewAgeDays?: number;
}

/** Eine Aussage samt ihrer Quelle und ihrem Zustand — das Ergebnis einer Suche. */
export interface KnowledgeHit {
  statement: KnowledgeStatement;
  source: KnowledgeSource;
  freshness: KnowledgeFreshnessResult;
}
