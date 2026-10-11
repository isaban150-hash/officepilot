/**
 * GO-LIVE-SECURITY-01 / FINALISIERUNG — welcher abgelegten E-Rechnung der Client trauen darf,
 * und wer überhaupt etwas ablegt.
 *
 * Seit 20261106120000 legt nur Inhaber oder Admin E-Rechnungsbindungen an, und nur unter
 * allen Serverprüfungen. Was davor entstand, kann von einem Mitglied stammen. Der Server
 * markiert es (`einvoice_untrusted_at`, 20261107120000); kein Client kann die Marke setzen
 * oder entfernen.
 *
 *  - Eine markierte Datei wird nur ausgeliefert, wenn eine frische Erzeugung aus der
 *    festgeschriebenen Rechnung exakt dieselben Bytes ergibt. Beide Erzeuger sind
 *    deterministisch: Gleiche Bytes sind genau das, was dieser Client selbst erzeugt hätte,
 *    und die Herkunft spielt keine Rolle mehr.
 *  - Weicht sie ab, wird sie nie ausgeliefert. Inhaber und Admin ersetzen sie durch die
 *    eigene Erzeugung; die Marke entfernt der Server erst dabei, unter allen Prüfungen.
 *  - Mitglieder legen nichts ab. Sie bekommen die frisch erzeugte Datei zum Herunterladen,
 *    ohne Datei, Bindung oder Sync-Auftrag. Eine Cloud-Bindung entsteht nur durch
 *    Inhaber oder Admin — der Server weist alles andere ohnehin ab.
 *
 * Grenze: Das schützt unveränderte Geräte vor fremden Altdateien. Gegen einen manipulierten
 * Client schützt allein der Server (Rolle, Prüfungen, Marke).
 */
import {
  normalizeDocumentFileRepresentationBindingPart,
  type DocumentFileRepresentationBinding,
} from '../../types/documentFileRepresentationBinding';
import { createDocumentFileRepresentationBinding } from '../documentFileRepresentationBindingService';
import { resolveOutputWriteAccess } from '../invoice/invoiceOutputGuard';

/** Trägt die Bindung die Vertrauensmarke des Servers? */
export function isUntrustedEInvoiceBinding(
  binding: Pick<DocumentFileRepresentationBinding, 'einvoiceUntrustedAt'> | undefined,
): boolean {
  return Boolean(binding?.einvoiceUntrustedAt);
}

/**
 * Legt dieser Client eine erzeugte E-Rechnung in der Ablage ab? Ein angemeldetes Mitglied
 * nicht. Inhaber, Admin und der lokale Betrieb ja — und, wie an der Ausgabegrenze, eine
 * noch ungeklärte Rolle: Dann entscheidet der Server. Er weist ein Mitglied ab, und der
 * Client räumt die Abweisung beim nächsten Abzug auf (`planRoleDeniedEInvoiceBindingRelease`).
 */
export async function mayStoreEInvoiceArtifact(): Promise<boolean> {
  return (await resolveOutputWriteAccess()).reason !== 'member';
}

function sameBindingKey(left: DocumentFileRepresentationBinding, right: DocumentFileRepresentationBinding): boolean {
  return (
    left.documentId === right.documentId &&
    left.kind === right.kind &&
    normalizeDocumentFileRepresentationBindingPart(left.part) === normalizeDocumentFileRepresentationBindingPart(right.part)
  );
}

/**
 * Ersetzt eine markierte Altbindung durch die eigene Erzeugung: dieselbe Bindung (Beleg,
 * Rolle, Unterrolle) mit der neuen Datei, ohne Marke, mit dem Serverstand der alten —
 * damit der Sync sie mit der richtigen Version als Änderung sendet. Alle anderen
 * Bindungen bleiben, wie sie sind.
 */
export function replaceUntrustedEInvoiceBinding(
  bindings: readonly DocumentFileRepresentationBinding[],
  existing: DocumentFileRepresentationBinding,
  fileRefId: string,
): DocumentFileRepresentationBinding[] {
  const replacement: DocumentFileRepresentationBinding = {
    ...createDocumentFileRepresentationBinding({
      documentId: existing.documentId,
      kind: existing.kind,
      fileRefId,
      part: existing.part,
    }),
    ...(existing.sync ? { sync: { ...existing.sync } } : {}),
  };
  return bindings.map((entry) => (sameBindingKey(entry, existing) ? replacement : entry));
}
