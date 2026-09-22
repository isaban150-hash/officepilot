import type { CustomerBilling, OrderUnit, TaxStatus } from './models';

/**
 * AUFTRAG-02C — der lokale Auftragsentwurf.
 *
 * Ein Entwurf ist **kein** Auftrag: kein Vorgang, keine Auftragsnummer, keine
 * Cloud. Er existiert nur auf diesem Gerät und nur so lange, bis der Nutzer
 * den Auftrag verbindlich anlegt — danach ist die Serverzeile die Wahrheit und
 * der Entwurf verschwindet.
 *
 * `id` ist zugleich die spätere Vorgangskennung und damit der
 * Idempotenzschlüssel für `create_workspace_order`: Sie entsteht einmal beim
 * Anlegen des Entwurfs und überlebt Wiederaufnahme, Retry und Absturz.
 */
export interface OrderDraftPosition {
  id: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitPrice: number;
}

export interface OrderDraft {
  /** Zugleich die spätere Vorgangskennung (`v-…`) und der Idempotenzschlüssel. */
  id: string;
  workspaceId: string;
  customerId?: string;
  customerBilling: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OrderDraftPosition[];
  taxStatus: TaxStatus;
  paymentTermsText: string;
  introText?: string;
  closingText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDraftInput {
  customerId?: string;
  customerBilling: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OrderDraftPosition[];
  taxStatus: TaxStatus;
  paymentTermsText: string;
  introText?: string;
  closingText?: string;
}

/** Gründe, aus denen ein Entwurf noch nicht verbindlich angelegt werden kann. */
export type OrderDraftBlocker =
  | 'customer_missing'
  | 'title_missing'
  | 'positions_missing'
  | 'position_invalid';
