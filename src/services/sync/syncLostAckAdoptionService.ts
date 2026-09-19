/**
 * SYNC-DURABILITY-HARDENING-01G4 — Wiederanlauf nach verlorener Bestätigung.
 *
 * Ein Schreibvorgang erreicht den Server, die Antwort erreicht den Client
 * nicht. Der Server ist damit weiter, als der Client glaubt: Er trägt eine
 * Fassung, für die es lokal keine bestätigte Version gibt, und der
 * Sendeauftrag steht weiter offen. Ohne Wiederanlauf endet jeder
 * Wiederholungsversuch im Versionskonflikt — die Arbeit bliebe für immer
 * liegen.
 *
 * Die entscheidende Frage ist immer dieselbe:
 *
 *   Stammt der neuere Serverstand von **uns** — oder von einem anderen Gerät?
 *
 * Geraten wird das nie. Es gibt genau zwei belastbare Nachweise:
 *
 *  1. **Die unberührte Erstzeile.** Jeder Schreibvorgang erhöht `row_version`,
 *     auch ein Grabstein. `row_version = 1` beweist deshalb, dass seit dem
 *     Einfügen kein weiterer Server-Write stattfand. Zusammen mit einer lokal
 *     fehlenden bestätigten Version (`0`) und einem offenen Sendeauftrag kann
 *     die Zeile nur der eigene, verlorene Anlegevorgang sein. Inhaltsgleichheit
 *     wird hier ausdrücklich **nicht** verlangt: Nach dem Funkloch arbeitet der
 *     Nutzer weiter, und genau dann wird der Wiederanlauf gebraucht.
 *
 *  2. **Der Sendenachweis.** Auf einer bereits bestätigten Fassung beweist die
 *     Versionszahl nichts mehr — `row_version = 2` kann der eigene verlorene
 *     Schreibvorgang oder die Arbeit eines Kollegen sein. Deshalb hält der
 *     Sendeweg fest, welchen fachlichen Stand er tatsächlich abgeschickt hat.
 *     Stimmt der Serverstand damit überein, war es der eigene; weicht er ab,
 *     bleibt es beim Konflikt und die lokale Arbeit steht.
 *
 * Der zweite Nachweis ist nötig, weil der aktuelle lokale Stand **nicht** als
 * Ersatz taugt: Zwischen dem Absenden und dem Wiederanlauf kann der Nutzer
 * weitergearbeitet haben. Verglichen wird deshalb das Abgeschickte, erhalten
 * bleibt das Aktuelle.
 *
 * Das Ergebnis ist ein Plan, keine Ausführung:
 *
 *   `adopt`  — die Serverversion wird zur bestätigten Basis, der lokale
 *              Fachstand bleibt unangetastet und geht erneut auf die Reise.
 *   `settle` — der gewünschte Serverstand besteht bereits; es gibt nichts mehr
 *              zu senden, der Auftrag ist erledigt.
 */

export interface LostAckAdoptionPlan {
  /** Basisversion übernehmen, lokalen Fachstand behalten, erneut senden. */
  adopt: string[];
  /** Der gewünschte Remote-Zustand besteht bereits — nichts mehr zu senden. */
  settle: string[];
  /**
   * Die Serverversion, die für die jeweilige Entität zur bestätigten Basis
   * wird. Beim Anlegevorgang ist das immer `1`; auf einer bestätigten Fassung
   * die tatsächlich vorgefundene Version.
   */
  baseVersions: ReadonlyMap<string, number>;
  /**
   * SYNC-DURABILITY-01G6 — die Entitäten, deren Sendenachweis hier
   * tatsächlich **bewertet** wurde: Nachweis lag vor, die Serverzeile lag vor,
   * beide wurden verglichen. Das Ergebnis kann Übernahme, Abschluss oder
   * Streit sein — entscheidend ist, dass die offene Frage beantwortet ist.
   *
   * Nur diese Nachweise dürfen aufgehoben werden. Blosse Anwesenheit einer
   * Kennung im Pull ist keine Bewertung: Dann bliebe ein ungeklärter
   * Schreibvorgang ohne Antwort zurück.
   */
  evaluatedProofs: string[];
  /**
   * SYNC-DURABILITY-01G7 — der Schreibvorgang hat den Server nachweislich
   * **nicht** erreicht: Die Serverzeile steht noch genau auf der bestätigten
   * Ausgangsbasis, oder sie existiert beim Anlegen überhaupt nicht.
   *
   * Der Nachweis ist damit beantwortet und darf den Auftrag nicht länger
   * zurückhalten. Die bestätigte Basis bleibt, wie sie ist — erst ein
   * tatsächlich angenommener Schreibvorgang erhöht sie.
   */
  notAccepted: string[];
}

/** Der Serverstand einer Zeile, soweit er für den Wiederanlauf zählt. */
export interface LostAckRemoteRow {
  rowVersion: number;
  deleted: boolean;
  /** Fachlicher Vergleichsschlüssel der Serverfassung; fehlt bei Grabsteinen. */
  contentKey?: string;
}

/** Was zuletzt tatsächlich abgeschickt wurde — der Nachweis für Fall 2. */
export interface LostAckSentWrite {
  /** Fachlicher Vergleichsschlüssel des abgeschickten Standes. */
  contentKey?: string;
  /** Ob der abgeschickte Schreibvorgang eine Löschung war. */
  deleted: boolean;
}

interface LocalLike {
  id: string;
  sync?: { version?: number; deleted?: boolean };
}

export function planLostAckAdoption<T extends LocalLike>(
  locals: T[],
  remotes: ReadonlyMap<string, LostAckRemoteRow>,
  activeOutboxIds: ReadonlySet<string>,
  options?: {
    /** Der zuletzt abgeschickte Stand je Entität, aus dem offenen Sendeauftrag. */
    sentWrites?: ReadonlyMap<string, LostAckSentWrite>;
    /** Der fachliche Vergleichsschlüssel des **aktuellen** lokalen Standes. */
    localContentKey?: (entity: T) => string;
  },
): LostAckAdoptionPlan {
  const adopt: string[] = [];
  const settle: string[] = [];
  const baseVersions = new Map<string, number>();
  const evaluatedProofs: string[] = [];
  const notAccepted: string[] = [];

  for (const local of locals) {
    if (!activeOutboxIds.has(local.id)) continue;

    const localVersionVorab = local.sync?.version ?? 0;
    const sentVorab = options?.sentWrites?.get(local.id);
    const remote = remotes.get(local.id);

    if (!remote) {
      /*
       * 01G7 — ein Anlegevorgang, dessen Zeile nach dem Abgleich gar nicht
       * existiert. Ein angenommener Anlegevorgang hätte eine Zeile mit
       * Version 1 hinterlassen, und selbst eine anderswo gelöschte käme als
       * Grabstein zurück. Fehlt sie vollständig, ist nichts angekommen.
       *
       * Nur für den Anlegevorgang: Bei einer bestätigten Fassung wäre eine
       * fehlende Zeile mehrdeutig, und daraus wird nichts geschlossen.
       */
      if (sentVorab && localVersionVorab === 0) {
        evaluatedProofs.push(local.id);
        notAccepted.push(local.id);
        baseVersions.set(local.id, 0);
      }
      continue;
    }

    const localVersion = local.sync?.version ?? 0;
    const locallyDeleted = local.sync?.deleted === true;

    /* ---- Fall 1: die unberührte Erstzeile ---- */
    if (localVersion === 0) {
      if (remote.rowVersion !== 1) continue;

      if (!remote.deleted) {
        adopt.push(local.id);
        baseVersions.set(local.id, remote.rowVersion);
        continue;
      }

      /*
       * Grabstein: Nur wenn auch lokal gelöscht werden sollte, ist der Wunsch
       * bereits erfüllt. Gegen einen lokal **aktiven** Datensatz bleibt es beim
       * regulären Konflikt — eine Übernahme führte beim nächsten Push zur
       * stillen Wiederbelebung.
       */
      if (locallyDeleted) {
        settle.push(local.id);
        baseVersions.set(local.id, remote.rowVersion);
      }
      continue;
    }

    /* ---- Fall 2: bestätigte Fassung, Nachweis über das Abgeschickte ---- */

    /*
     * 01G7 — zuerst die Gegenprobe: Steht der Server noch **exakt** auf der
     * bestätigten Basis, kann der abgeschickte Schreibvorgang nicht
     * angenommen worden sein — jeder angenommene erhöht die Version. Das ist
     * ein Beweis, keine Annahme, und er braucht keine Zeitschätzung.
     *
     * Verlangt wird ausdrücklich Gleichstand, nicht blosse Ungleichheit der
     * Inhalte: Liegt der Server darüber, könnte sehr wohl etwas angekommen
     * sein, und dann gilt der reguläre Weg.
     */
    if (
      options?.sentWrites?.get(local.id) &&
      remote.rowVersion === localVersion &&
      !remote.deleted
    ) {
      evaluatedProofs.push(local.id);
      notAccepted.push(local.id);
      baseVersions.set(local.id, localVersion);
      continue;
    }

    if (remote.rowVersion <= localVersion) continue;

    const sent = options?.sentWrites?.get(local.id);
    if (!sent) continue;

    /*
     * Ab hier wird der Nachweis gegen die Serverzeile gehalten. Wie der
     * Vergleich ausgeht, ändert nichts daran, dass er stattgefunden hat.
     */
    evaluatedProofs.push(local.id);

    if (sent.deleted) {
      // Der eigene Löschwunsch ist bereits angekommen — mehr war nicht gewollt.
      if (remote.deleted && locallyDeleted) {
        settle.push(local.id);
        baseVersions.set(local.id, remote.rowVersion);
      }
      continue;
    }

    /*
     * Ein Grabstein kann nie die Bestätigung eines aktiven Schreibvorgangs
     * sein: Dann hat jemand anders gelöscht, und das ist ein echter Konflikt.
     */
    if (remote.deleted) continue;
    if (!sent.contentKey || !remote.contentKey) continue;
    if (sent.contentKey !== remote.contentKey) continue;

    baseVersions.set(local.id, remote.rowVersion);

    /*
     * Der Server trägt genau das, was abgeschickt wurde. Hat sich lokal seither
     * nichts getan, ist der Auftrag erledigt; sonst geht die neuere Fassung auf
     * der frisch bestätigten Basis erneut auf die Reise.
     */
    const currentKey = options?.localContentKey?.(local);
    if (!locallyDeleted && currentKey !== undefined && currentKey === sent.contentKey) {
      settle.push(local.id);
    } else {
      adopt.push(local.id);
    }
  }

  return { adopt, settle, baseVersions, evaluatedProofs, notAccepted };
}
