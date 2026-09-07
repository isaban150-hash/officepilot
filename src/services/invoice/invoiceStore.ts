/**
 * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — die Rechnung bekommt einen eigenen Ort.
 *
 * Lokal war eine Rechnung bisher ein Element von `vorgang.invoices[]`. Wer sie
 * suchte, ohne ihren Vorgang zu kennen, musste alle Vorgänge durchlaufen; wer
 * sie änderte, änderte in Wahrheit einen Vorgang. In der Cloud ist das längst
 * anders — `workspace_invoices` ist eine eigene Tabelle, und Zahlungen wie
 * Versandstatus adressieren dort bereits über die Rechnungskennung.
 *
 * Dieser Speicher zieht die lokale Seite nach: Er ist ab dem Cutover die
 * **einzige** lokale Rechnungswahrheit. `vorgang.invoices` wird zur Sicht
 * darauf, abgeleitet in `cloneVorgang` — es gibt keinen zweiten Schreibweg und
 * damit nichts, was auseinanderlaufen könnte.
 *
 * **Kein eigener Speicherort.** Die Einträge reisen im selben
 * `AppPersistedState` und im selben `persistAll()` wie alles andere. Das ist
 * Absicht: Rechnung, Zahlung, Versandstatus und Archivverweis müssen bei einem
 * Absturz gemeinsam stehen oder gemeinsam fallen — eine zweite
 * Transaktionsgrenze wäre genau die Fehlerquelle, die es zu vermeiden gilt.
 */
import type { StoredInvoiceEntry, VorgangInvoice } from '../../types/models';

/**
 * Die lokale Rechnungs-SSOT. Reihenfolge ist bedeutungstragend: Der
 * Nummernkreis leitet daraus Höchstwerte ab, und neue Rechnungen stehen wie
 * bisher vorn.
 */
let entries: StoredInvoiceEntry[] = [];

function cloneEntry(entry: StoredInvoiceEntry): StoredInvoiceEntry {
  return { invoice: { ...entry.invoice }, vorgangId: entry.vorgangId };
}

/** Ersetzt den gesamten Bestand — beim Laden und bei einer Wiederherstellung. */
export function hydrateInvoiceStore(next: readonly StoredInvoiceEntry[]): void {
  entries = next.map(cloneEntry);
}

export function getInvoiceStoreSnapshot(): StoredInvoiceEntry[] {
  return entries.map(cloneEntry);
}

export function resetInvoiceStore(): void {
  entries = [];
}

/**
 * Die Rechnungen eines Vorgangs, in ihrer gespeicherten Reihenfolge.
 *
 * Quelle für die Laufzeitsicht `vorgang.invoices`. Bewusst ein Filter und kein
 * gepflegter Index: Ein Index bräuchte eine Invalidierung, und genau dort
 * entstünde wieder ein Zustand, der veralten kann.
 */
export function listInvoicesForVorgang(vorgangId: string): VorgangInvoice[] {
  return entries
    .filter((entry) => entry.vorgangId === vorgangId)
    .map((entry) => ({ ...entry.invoice }));
}

/**
 * Setzt die Rechnungen **eines** Vorgangs auf den übergebenen Stand.
 *
 * Die Einträge fremder Vorgänge bleiben unberührt, und die Rechnungen dieses
 * Vorgangs behalten ihre Position im Gesamtbestand: Der erste bisherige Platz
 * dieses Vorgangs nimmt die neue Liste auf. So bleibt die Reihenfolge über alle
 * Vorgänge hinweg stabil — und damit die Ableitung des Nummernkreises.
 */
export function setInvoicesForVorgang(
  vorgangId: string,
  invoices: readonly VorgangInvoice[],
): void {
  const replacement = invoices.map((invoice) => ({ invoice: { ...invoice }, vorgangId }));
  const insertAt = entries.findIndex((entry) => entry.vorgangId === vorgangId);
  const others = entries.filter((entry) => entry.vorgangId !== vorgangId);

  if (insertAt === -1) {
    entries = [...others, ...replacement];
    return;
  }

  const before = entries.slice(0, insertAt).filter((entry) => entry.vorgangId !== vorgangId);
  entries = [...before, ...replacement, ...others.slice(before.length)];
}

/**
 * Übernimmt die Rechnungen, die an Vorgängen hängen, in den zentralen Speicher.
 *
 * Der Weg, auf dem ein V5-Bestand und jede Testvorbereitung hier ankommen:
 * `hydrateVorgangStore` reicht die Vorgänge samt ihrer Rechnungen durch, und
 * danach trägt sie ausschliesslich dieser Speicher.
 */
export function absorbInvoicesFromVorgaenge(
  vorgaenge: readonly { id: string; invoices?: VorgangInvoice[] }[],
): void {
  entries = vorgaenge.flatMap((vorgang) =>
    (vorgang.invoices ?? []).map((invoice) => ({
      invoice: { ...invoice },
      vorgangId: vorgang.id,
    })),
  );
}
