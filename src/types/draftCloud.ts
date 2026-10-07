/**
 * CLOUD-SYNC S6 — wie ein Gerät den Cloud-Zustand eines Auftrags- oder
 * Nachtragsentwurfs festhält, der zu seiner eigenen, noch nicht übertragenen
 * Arbeit nicht passt.
 *
 * Beide Entwürfe sind eigene Entitäten mit eigenen Tabellen und eigenen
 * Verbrauchswegen. Gemeinsam ist ihnen nur diese Form: Der Konflikt hängt am
 * lokalen Entwurf, trägt den Serverstand, und die Entscheidung trifft der
 * Nutzer sichtbar — nichts wird still zusammengeführt oder überschrieben.
 */

/** Was nur der Server setzt: aktiv oder zur kanonischen Fachwahrheit geworden. */
export type DraftCloudStatus = 'active' | 'consumed';

/**
 *  - `version`          — der Entwurf wurde auf einem anderen Gerät geändert;
 *  - `deleted`          — er wurde auf einem anderen Gerät verworfen;
 *  - `consumed`         — aus ihm ist anderswo der Auftrag bzw. der bestätigte
 *                         Nachtrag geworden;
 *  - `discard_rejected` — hier verworfen, auf einem anderen Gerät aber
 *                         inzwischen geändert: Das Verwerfen wurde nicht
 *                         übernommen, der geänderte Entwurf ist wieder da.
 */
export type DraftCloudConflictKind = 'version' | 'deleted' | 'consumed' | 'discard_rejected';

export interface DraftCloudRemoteState<P> {
  rowVersion: number;
  status: DraftCloudStatus;
  deleted: boolean;
  /** `null` bei einem Endzustand — er reist ohne Inhalt. */
  payload: P | null;
  /** Nur bei `consumed`: der Auftrag bzw. der bestätigte Nachtrag. */
  consumedRef?: string;
}

export interface DraftCloudConflict<P> {
  kind: DraftCloudConflictKind;
  detectedAt: string;
  remote: DraftCloudRemoteState<P>;
}
