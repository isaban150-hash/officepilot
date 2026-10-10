/**
 * TEST-INFRA-GOLD-SCHUTZ-01 — globaler Schutz-Setup für jeden Vitest-Lauf.
 *
 * Vor dem Lauf: Alle geschützten Artefakte müssen vorhanden sein, sonst bricht der Lauf ab, bevor
 * ein Test startet (auch bei gezielter Testauswahl). Nichts wird neu erzeugt oder ersetzt.
 *
 * Nach dem Lauf: Fehlt eine Datei oder hat sich eine verändert, scheitert der Lauf. Die
 * Gold-Berichte dürfen sich nur ändern, wenn `GOLD_WRITE_REPORT=1` schon zu Laufbeginn galt; die
 * Freigabe wird einmal beim Start festgehalten, spätere Änderungen der Umgebung zählen nicht. Der
 * Snapshot ist immer geschützt. Ein vorbestehender Arbeitsbaumstand (Status `M`) ist kein Fehler;
 * verglichen wird nur Anfang gegen Ende desselben Laufs.
 */
import { isGoldReportWriteEnabled } from '../testWorld/goldReportWriteGate';
import { changedProtectedArtifacts, hashArtifacts, missingProtectedArtifacts } from './protectedArtifacts';

const HINWEIS = 'Nicht neu erzeugen, ersetzen oder wiederherstellen — den Nutzer entscheiden lassen.';

/** Prüft und misst jetzt und liefert die Prüfung für das Laufende; testbar mit eigener Wurzel und Umgebung. */
export function createProtectedArtifactsGuard(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): () => void {
  const goldWriteEnabled = isGoldReportWriteEnabled(env);
  const before = hashArtifacts(root);
  const missingAtStart = missingProtectedArtifacts(before);
  if (missingAtStart.length > 0) {
    throw new Error(
      `TEST-INFRA-GOLD-SCHUTZ-01: Geschützte Artefakte fehlen vor Testbeginn: ${missingAtStart.join(', ')}. ${HINWEIS}`,
    );
  }
  return () => {
    const after = hashArtifacts(root);
    const missing = missingProtectedArtifacts(after);
    const changed = changedProtectedArtifacts(before, after, { goldWriteEnabled }).filter(
      (path) => !missing.includes(path),
    );
    const problems = [
      ...(missing.length > 0 ? [`fehlen nach dem Lauf: ${missing.join(', ')}`] : []),
      ...(changed.length > 0 ? [`verändert: ${changed.join(', ')}`] : []),
    ];
    if (problems.length > 0) {
      throw new Error(
        `TEST-INFRA-GOLD-SCHUTZ-01: Der Testlauf hat geschützte Artefakte verändert — ${problems.join('; ')}. ${HINWEIS}`,
      );
    }
  };
}

export default function setup(): () => void {
  return createProtectedArtifactsGuard(process.cwd());
}
