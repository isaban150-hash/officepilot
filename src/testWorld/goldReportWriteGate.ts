/**
 * TEST-INFRA-GOLD-SCHUTZ-01 — die ausdrückliche Freigabe zum Schreiben der Gold-Berichte.
 *
 * Die beiden Berichte unter `test-world/reports/` sind geschützte Artefakte. Der Gold-Test
 * berechnet und prüft sein Ergebnis immer; geschrieben wird es nur mit `GOLD_WRITE_REPORT=1`
 * (genau der Wert `1`, nichts anderes). Kein npm-Testskript setzt diese Variable;
 * `vitest.safe.config.ts` schaltet sie zusätzlich ab.
 *
 * Bewusst ohne weitere Importe: Der globale Schutz-Setup läuft im Hauptprozess von Vitest.
 */
export const GOLD_WRITE_REPORT_ENV = 'GOLD_WRITE_REPORT';

export function isGoldReportWriteEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[GOLD_WRITE_REPORT_ENV] === '1';
}
