/**
 * BROWSER-ACCEPTANCE-FIX 01 / B1 — Anzahl mit natürlichem Singular/Plural.
 * „1 überfällige Rechnung", „3 überfällige Rechnungen" statt „Rechnung(en)".
 */
export function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
