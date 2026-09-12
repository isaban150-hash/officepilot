import type { OrderUnit } from '../types/models';

/**
 * MANUAL-INVOICE-UI-01B1B — die wählbaren Einheiten, an einer Stelle.
 *
 * Bisher standen sie zweimal lokal in Vorgangsformularen; der freie
 * Positionseditor braucht dieselbe Liste und bekommt sie von hier, statt eine
 * dritte Kopie anzulegen. Die Reihenfolge ist die der bestehenden Formulare.
 */
export const ORDER_UNITS: readonly OrderUnit[] = ['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
