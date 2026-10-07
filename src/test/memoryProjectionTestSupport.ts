import { vi } from 'vitest';
import * as memoryStore from '../services/officePilotMemoryStore';

/**
 * CLOUD-SYNC S4 — Test-only: Die Gedächtnis-Projektion ruht für die Dauer
 * eines Tests. Sie wird weiter berechnet, ihr Ergebnis aber nicht übernommen —
 * so bleibt sichtbar, was die bisherigen Schreibwege selbst ins Gedächtnis
 * schreiben. Kein Schalter im Produkt; der Spion endet mit `mockRestore()`
 * bzw. `vi.restoreAllMocks()`.
 */
export function suspendMemoryProjectionForTest() {
  return vi.spyOn(memoryStore, 'replaceDerivedMemoryCollectionsInStore').mockImplementation(() => undefined);
}
