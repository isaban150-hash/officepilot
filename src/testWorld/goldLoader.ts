/**
 * TestWorld gold loader — reads metas + expected from test-world/documents.
 * No OfficePilot domain mutation beyond what callers do with returned fixtures.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { mapKindToDocumentType } from '../services/documentClassificationCatalog';
import type { ClassifiedDocumentKind, DocumentType, InboxItem, Vorgang } from '../types/models';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';

export type GoldExpectedClassification = {
  documentId: string;
  taxonomyTypeId: string;
  documentType: string;
  subtype: string;
  label: string;
  classifiedKind: string;
  family: string;
};

export type GoldExpectedSummary = {
  documentId: string;
  family: string;
  headline: string;
  factOrder: string[];
  facts: Array<{ id: string; value: string }>;
};

export type GoldExpectedCaseMatch = {
  documentId: string;
  matchStatus: 'exact' | 'likely' | 'multiple' | 'none';
  matchedProjectId: string | null;
  reasons: string[];
  candidates: Array<{ projectId: string; reasons: string[] }>;
};

export type GoldExpectedPrimaryAction = {
  documentId: string;
  id: string;
};

export type GoldExpectedAlerts = {
  documentId: string;
  alertIds: string[];
};

export type GoldDocumentMeta = {
  id: string;
  companyId: string;
  projectId?: string | null;
  customerId?: string;
  supplierId?: string;
  employeeId?: string;
  vehicleId?: string;
  taxonomyTypeId: string;
  documentType: string;
  subtype: string;
  title: string;
  receivedAt: string;
};

export type GoldMasterMaps = {
  customers: Map<string, { id: string; name: string }>;
  suppliers: Map<string, { id: string; name: string }>;
  employees: Map<string, { id: string; firstName: string; lastName: string }>;
  vehicles: Map<string, { id: string; label: string; licensePlate?: string }>;
  projects: Map<
    string,
    {
      id: string;
      title: string;
      customerId: string;
      siteName?: string;
      siteStreet?: string;
      siteCity?: string;
      trade?: string;
    }
  >;
};

export type GoldDocumentBundle = {
  meta: GoldDocumentMeta;
  classification: GoldExpectedClassification;
  summary: GoldExpectedSummary;
  caseMatch: GoldExpectedCaseMatch;
  primaryAction: GoldExpectedPrimaryAction;
  alerts: GoldExpectedAlerts;
};

const EXPECTED_FILES = [
  'classification.json',
  'summary.json',
  'caseMatch.json',
  'primaryAction.json',
  'alerts.json',
] as const;

export function resolveTestWorldRoot(cwd: string = process.cwd()): string {
  return join(cwd, 'test-world');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadEntityMap<T extends { id: string }>(dir: string): Map<string, T> {
  const map = new Map<string, T>();
  if (!existsSync(dir)) return map;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const row = readJson<T>(join(dir, file));
    map.set(row.id, row);
  }
  return map;
}

export function loadGoldMasterData(testWorldRoot: string = resolveTestWorldRoot()): GoldMasterMaps {
  return {
    customers: loadEntityMap(join(testWorldRoot, 'customers')),
    suppliers: loadEntityMap(join(testWorldRoot, 'suppliers')),
    employees: loadEntityMap(join(testWorldRoot, 'employees')),
    vehicles: loadEntityMap(join(testWorldRoot, 'vehicles')),
    projects: loadEntityMap(join(testWorldRoot, 'projects')),
  };
}

export function listGoldDocumentIds(testWorldRoot: string = resolveTestWorldRoot()): string[] {
  const docsDir = join(testWorldRoot, 'documents');
  return readdirSync(docsDir)
    .filter((name) => {
      const full = join(docsDir, name);
      return (
        name.startsWith('DOC-') &&
        statSync(full).isDirectory() &&
        existsSync(join(full, 'meta.json'))
      );
    })
    .sort();
}

export function loadGoldDocument(
  documentId: string,
  testWorldRoot: string = resolveTestWorldRoot(),
): GoldDocumentBundle {
  const dir = join(testWorldRoot, 'documents', documentId);
  const meta = readJson<GoldDocumentMeta>(join(dir, 'meta.json'));
  const expectedDir = join(dir, 'expected');
  for (const file of EXPECTED_FILES) {
    if (!existsSync(join(expectedDir, file))) {
      throw new Error(`${documentId}: missing expected/${file}`);
    }
  }
  return {
    meta,
    classification: readJson(join(expectedDir, 'classification.json')),
    summary: readJson(join(expectedDir, 'summary.json')),
    caseMatch: readJson(join(expectedDir, 'caseMatch.json')),
    primaryAction: readJson(join(expectedDir, 'primaryAction.json')),
    alerts: readJson(join(expectedDir, 'alerts.json')),
  };
}

export function loadAllGoldDocuments(
  testWorldRoot: string = resolveTestWorldRoot(),
): GoldDocumentBundle[] {
  return listGoldDocumentIds(testWorldRoot).map((id) => loadGoldDocument(id, testWorldRoot));
}

function siteLine(project: {
  title: string;
  siteName?: string;
  siteStreet?: string;
  siteCity?: string;
}): string {
  const street = project.siteStreet?.trim();
  const city = project.siteCity?.trim();
  if (street && city) return `${street}, ${city}`;
  return project.siteName || project.title;
}

/**
 * Build InboxItem fixture from gold meta + expected classification.
 * Seeds RD enough for OfficePilot summary/match without OCR/PDF.
 */
export function goldBundleToInboxItem(
  bundle: GoldDocumentBundle,
  masters: GoldMasterMaps,
): InboxItem {
  const { meta, classification } = bundle;
  const kind = classification.classifiedKind as ClassifiedDocumentKind;
  const documentType = mapKindToDocumentType(kind) as DocumentType;
  const customer = meta.customerId ? masters.customers.get(meta.customerId) : undefined;
  const supplier = meta.supplierId ? masters.suppliers.get(meta.supplierId) : undefined;
  const project = meta.projectId ? masters.projects.get(meta.projectId) : undefined;
  const vehicle = meta.vehicleId ? masters.vehicles.get(meta.vehicleId) : undefined;

  const partyName = supplier?.name || customer?.name || 'Cirmak Haustechnik';
  const recognizedData: Record<string, string> = {
    // Clear createAuftragInboxItem defaults that leak into money facts.
    Leistung: '',
    Angebotssumme: '',
    Betreff: meta.title,
    Datum: meta.receivedAt,
  };

  if (customer) {
    recognizedData.Auftraggeber = customer.name;
    recognizedData.Kunde = customer.name;
  }
  if (supplier) {
    recognizedData.Lieferant = supplier.name;
    recognizedData.Absender = supplier.name;
  }
  if (classification.family === 'tank' && supplier) {
    recognizedData.Tankstelle = supplier.name;
  }
  if (project) {
    recognizedData.Bauvorhaben = project.title;
    recognizedData.Projekt = project.title;
    recognizedData.Vorgang = project.title;
    recognizedData.Baustelle = siteLine(project);
    recognizedData.Baustellenadresse = siteLine(project);
    if (project.trade) recognizedData.Gewerk = project.trade;
  }

  // Avoid clean-gold alert noise (money-missing / delivery-qty).
  if (
    classification.family === 'invoice_in' ||
    classification.family === 'invoice_out' ||
    classification.family === 'tank' ||
    classification.family === 'offer'
  ) {
    recognizedData.Betrag = '100,00 EUR';
  }
  if (classification.family === 'delivery') {
    recognizedData.Menge = '1 Palette';
  }
  if (vehicle?.licensePlate) {
    recognizedData.Referenz = vehicle.licensePlate;
    recognizedData.Aktenzeichen = vehicle.licensePlate;
  }

  return createAuftragInboxItem({
    id: meta.id,
    title: meta.title,
    sender: partyName,
    classifiedKind: kind,
    documentType,
    receivedAt: meta.receivedAt,
    // U02: meta.projectId is business context only — never inject vorgangId/known_link.
    // exact/open_vorgang only when buildDocumentCaseMatch finds a real unique Vorgang.
    recognizedData,
  });
}

/** Map each TestWorld project to a Vorgang; id === projectId for expected matchedProjectId. */
export function goldProjectsToVorgaenge(masters: GoldMasterMaps): Vorgang[] {
  const list: Vorgang[] = [];
  for (const project of masters.projects.values()) {
    const customer = masters.customers.get(project.customerId);
    list.push(
      createTestVorgang({
        id: project.id,
        title: project.title,
        customer: customer?.name ?? project.customerId,
        baustelle: siteLine(project),
      }),
    );
  }
  return list;
}
