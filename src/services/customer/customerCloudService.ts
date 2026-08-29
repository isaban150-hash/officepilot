/**
 * PRODUCT-FOUNDATION-03A-C1 — Cloud-Anbindung des Kundenstamms.
 *
 * Diese Datei trägt ausschliesslich Transport: Payload, Content-Key, Parsen der
 * Serverzeile, Merge und Backfill-Planung. Sie enthält **keine** Fachlogik —
 * Anlage, Änderung, Eigenfirmen-Guard und Auswahl bleiben unverändert in
 * `customerService` und `customerOwnCompanyGuard`.
 *
 * Die Serverform stammt aus `20250829120000_workspace_customers_cloud.sql` und
 * folgt dem `workspace_vorgaenge`-Muster.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import type { Customer } from '../../types/models';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_customers` — exakt die Spalten der Migration. */
export interface WorkspaceCustomerRow {
  workspace_id: string;
  customer_id: string;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Fachlicher Cloud-Payload eines Kunden — ohne jede Cloud-Metainformation. */
export interface CustomerCloudPayload {
  id: string;
  name: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
  createdFromInboxId?: string;
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Content-Key wandern. `sync` bleibt draussen —
 * `updatedAt` dagegen ist der **fachliche** Änderungszeitstempel und gehört
 * hinein, sonst bliebe eine Rücknahme auf einen früheren Wert unerkannt.
 */
export function stripCustomerForCloud(customer: Customer): CustomerCloudPayload {
  const payload: CustomerCloudPayload = {
    id: customer.id,
    name: customer.name,
    contactPerson: customer.contactPerson,
    street: customer.street,
    zip: customer.zip,
    city: customer.city,
    email: customer.email,
    phone: customer.phone,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
  // Provenance reist nur mit, wenn sie existiert — wie beim Vorgang.
  if (customer.createdFromInboxId) {
    payload.createdFromInboxId = customer.createdFromInboxId;
  }
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Push eine neue `row_version` zurück; flösse
 * sie hier ein, löste jede Rückschreibung den nächsten Push aus — genau die
 * Schleife, die bei den Firmendaten schon einmal auftrat.
 */
export function buildCustomerCloudContentKey(customer: Customer): string {
  return JSON.stringify(stripCustomerForCloud(customer));
}

/** Push-Form nach dem Vorgangs-Muster: Identität, Nutzlast, Grabstein-Flag. */
export function buildCustomerCloudPushPayload(
  customer: Customer,
  deleted = false,
): Record<string, unknown> {
  return {
    customer_id: customer.id,
    payload: stripCustomerForCloud(customer),
    deleted,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseCustomerCloudPayload(
  payload: Record<string, unknown> | null,
): CustomerCloudPayload | null {
  if (!payload) return null;
  const inner =
    (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id)) return null;

  const parsed: CustomerCloudPayload = {
    id: inner.id,
    name: text(inner.name),
    contactPerson: text(inner.contactPerson),
    street: text(inner.street),
    zip: text(inner.zip),
    city: text(inner.city),
    email: text(inner.email),
    phone: text(inner.phone),
    createdAt: text(inner.createdAt),
    updatedAt: text(inner.updatedAt),
  };
  if (isNonEmptyString(inner.createdFromInboxId)) {
    parsed.createdFromInboxId = inner.createdFromInboxId;
  }
  return parsed;
}

export function mapWorkspaceCustomerRow(row: WorkspaceCustomerRow): {
  customerId: string;
  payload: CustomerCloudPayload;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  const parsed = parseCustomerCloudPayload(row.payload);
  if (!parsed) return null;
  return {
    // Die serverseitige `customer_id` ist die Cloud-Identität.
    customerId: row.customer_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

function customerFromCloud(
  customerId: string,
  payload: CustomerCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Customer {
  return {
    ...payload,
    id: customerId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  };
}

/**
 * Zeilenweiser Merge nach `customer.id`, aufgebaut auf der vorhandenen
 * `mergeSyncEntities`-Engine. Kein Feld-Merge, keine Last-Write-Wins-Regel:
 * Gleiche Version mit abweichendem Inhalt meldet einen Konflikt, statt eine
 * ungesynchronisierte lokale Änderung stillschweigend zu verwerfen.
 */
export function mergeCustomersFromPull(
  localCustomers: Customer[],
  remoteRows: WorkspaceCustomerRow[],
  deviceId: string,
  workspaceId: string,
): { customers: Customer[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localCustomers.map((customer) => [customer.id, customer]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceCustomerRow(row);
    if (!mapped) continue;

    const local = byId.get(mapped.customerId) ?? null;
    const remote = customerFromCloud(
      mapped.customerId,
      mapped.payload,
      mapped.rowVersion,
      mapped.updatedAt,
      mapped.deleted,
      deviceId,
      workspaceId,
    );

    /*
     * Grabsteine werden vor der Merge-Engine behandelt. Sie würde einen
     * Grabstein gegen einen aktiven lokalen Datensatz als Konflikt melden —
     * für den es in V1 keinen Auflösungsweg gäbe, weil der Client gar nicht
     * löschen kann. Die Löschung hat auf dem anderen Gerät stattgefunden; hier
     * verschwindet der Kunde aus dem aktiven Bestand.
     */
    if (mapped.deleted) {
      byId.delete(mapped.customerId);
      continue;
    }

    if (!local) {
      byId.set(remote.id, remote);
      continue;
    }

    /*
     * Gleiche Version: Nur ein abweichender **fachlicher** Inhalt ist ein
     * Konflikt. Stimmt er überein, wird lediglich die Serverversion
     * übernommen — ohne Push und ohne Konfliktmeldung.
     */
    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (buildCustomerCloudContentKey(local) === buildCustomerCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`customer:${mapped.customerId}`);
      }
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'customer');
    if (merged.conflict) {
      conflicts.push(`customer:${mapped.customerId}`);
      continue;
    }

    const entity = merged.entity;
    if (entity) byId.set(entity.id, entity);
  }

  return { customers: [...byId.values()], conflicts };
}

/**
 * Backfill B — der einzige Weg, auf dem Bestandskunden in die Cloud gelangen.
 *
 * Der Change-Tracker kann das nicht leisten: Beim Start wird der vorhandene
 * Zustand zur Basislinie, Bestandskunden gelten damit als unverändert und
 * werden nie eingereiht.
 *
 * Verglichen werden **ausschliesslich IDs** — nie Firmenname, Anschrift oder
 * E-Mail. Kein Feld des Kundendatensatzes kann Firmenidentität beweisen; zwei
 * gleichnamige Kunden mit verschiedenen IDs sind zwei Kunden.
 *
 * Ein Grabstein zählt als vorhandene ID: Sonst lüde ein zweites Gerät einen
 * anderswo gelöschten Kunden wieder hoch.
 */
export function planCustomerBackfill(
  localCustomers: Customer[],
  remoteRows: WorkspaceCustomerRow[],
): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.customer_id));
  return localCustomers
    .filter((customer) => !customer.sync?.deleted)
    .filter((customer) => !remoteIds.has(customer.id))
    .map((customer) => customer.id);
}

/**
 * CREATE-RETRY-CONFLICT-02 — Wiederanlauf nach verlorener Create-Bestätigung.
 *
 * Regel, Beweis und Abgrenzung stehen ausführlich bei
 * `planVorgangLostAckAdoption`; der Customer-Zweig der RPC ist strukturgleich,
 * also gilt hier dieselbe Semantik. Die wenigen Zeilen sind bewusst doppelt
 * geschrieben statt über eine der beiden Fachdateien geteilt: Eine Abhängigkeit
 * zwischen Kunden- und Vorgangsdienst nur für diesen Sonderfall wöge schwerer
 * als die Wiederholung.
 *
 * Kurzfassung: `sync.version === 0` beweist, dass dieser Client nie eine
 * Bestätigung erhielt; `row_version === 1` beweist, dass seit dem Einfügen kein
 * weiterer Server-Write erfolgte. Beides zusammen macht die Übernahme der
 * Basisversion gefahrlos — ohne Inhaltsvergleich, ohne Blick auf die
 * Outbox-Operation.
 */
export function planCustomerLostAckAdoption(
  localCustomers: Customer[],
  remoteRows: WorkspaceCustomerRow[],
  activeOutboxCustomerIds: ReadonlySet<string>,
): { adopt: string[]; settle: string[] } {
  const remotes = new Map(
    remoteRows.map((row) => [
      row.customer_id,
      { rowVersion: Number(row.row_version), deleted: Boolean(row.deleted) },
    ]),
  );
  const adopt: string[] = [];
  const settle: string[] = [];

  for (const customer of localCustomers) {
    if ((customer.sync?.version ?? 0) !== 0) continue;
    if (!activeOutboxCustomerIds.has(customer.id)) continue;

    const remote = remotes.get(customer.id);
    if (!remote || remote.rowVersion !== 1) continue;

    if (!remote.deleted) {
      adopt.push(customer.id);
      continue;
    }
    // Grabstein gegen aktiven lokalen Kunden: keine Übernahme, keine Wiederbelebung.
    if (customer.sync?.deleted === true) {
      settle.push(customer.id);
    }
  }

  return { adopt, settle };
}

/** Setzt nach erfolgreichem Push die Serverversion — ohne Fachdaten anzufassen. */
export function applyCustomerPushResultToState(
  customers: Customer[],
  customerId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Customer[] {
  return customers.map((customer) => {
    if (customer.id !== customerId) return customer;
    const sync: SyncMeta = {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : customer.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...customer, sync };
  });
}
