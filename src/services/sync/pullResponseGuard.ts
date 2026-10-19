/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, SYS-02 / D6) — eine Abzugsantwort ist vollständig oder sie zählt
 * nicht.
 *
 * Bisher wurde eine fehlende oder falsch geformte Liste still zu `[]`: `data?.expenses ?? []`. Ein abgeschnittener
 * oder fremder Antwortkörper sah damit aus wie „der Server hat keine Ausgaben, Zahlungen, Kontierungen oder
 * Abschlüsse“ — und der Abgleich arbeitete mit diesem leeren Stand weiter. Jetzt bricht der betroffene Abschnitt ab;
 * der Abgleich meldet ihn als Fehler und übernimmt für ihn nichts (der lokale Stand bleibt, wie er war).
 */
export class IncompletePullResponseError extends Error {
  constructor(
    readonly rpc: string,
    readonly feld: string,
  ) {
    super(`pull_incomplete: ${rpc} ohne gültiges Feld ${feld}`);
    this.name = 'IncompletePullResponseError';
  }
}

/** Die genannten Felder müssen Listen sein; sonst `IncompletePullResponseError`. */
export function requirePullLists<T extends string>(
  rpc: string,
  data: unknown,
  felder: readonly T[],
): Record<T, unknown[]> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new IncompletePullResponseError(rpc, '(Antwort)');
  const result = {} as Record<T, unknown[]>;
  for (const feld of felder) {
    const wert = (data as Record<string, unknown>)[feld];
    if (!Array.isArray(wert)) throw new IncompletePullResponseError(rpc, feld);
    result[feld] = wert;
  }
  return result;
}
