/**
 * TESTWORLD-IMPLEMENTATION-03A — expected results for gold DOC-00001…DOC-00035.
 * Usage: node test-world/_lib/seed-03a-expected.mjs
 *
 * No PDFs, OCR, or new documents. Uses frozen taxonomy + existing OfficePilot kinds/families.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const AUTHORITY_KINDS = new Set([
  'finanzamt',
  'bg_bau',
  'soka_bau',
  'berufsgenossenschaft',
  'handwerkskammer',
  'ihk',
  'gewerbeamt',
  'bauamt',
  'ordnungsamt',
  'agentur_fuer_arbeit',
  'deutsche_rentenversicherung',
  'zoll',
  'krankenkasse',
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
]);

/** Existing ClassifiedDocumentKind only — no new kinds. */
const CLASSIFIED_BY_DOCTYPE = {
  'DOCTYPE-006': 'werkvertrag',
  'DOCTYPE-004': 'angebot',
  'DOCTYPE-011': 'eingangsrechnung',
  'DOCTYPE-014': 'ausgangsrechnung',
  'DOCTYPE-010': 'lieferschein',
  'DOCTYPE-019': 'tankbeleg',
  'DOCTYPE-020': 'eingangsrechnung',
  'DOCTYPE-023': 'finanzamt',
  'DOCTYPE-022': 'bg_bau',
  'DOCTYPE-060': 'sonstiges',
  'DOCTYPE-024': 'aok',
  'DOCTYPE-036': 'eingangsrechnung',
  'DOCTYPE-037': 'brief',
  'DOCTYPE-040': 'rechnung',
  'DOCTYPE-041': 'rechnung',
  'DOCTYPE-042': 'rechnung',
  'DOCTYPE-043': 'eingangsrechnung',
  'DOCTYPE-044': 'eingangsrechnung',
  'DOCTYPE-045': 'fahrzeugversicherung',
  'DOCTYPE-029': 'betriebshaftpflicht',
  'DOCTYPE-046': 'leasingvertrag',
  'DOCTYPE-047': 'tuev_bericht',
  'DOCTYPE-048': 'reparaturrechnung',
  'DOCTYPE-051': 'arbeitsvertrag',
  'DOCTYPE-054': 'krankmeldung',
  'DOCTYPE-055': 'urlaubsantrag',
  'DOCTYPE-056': 'lohnabrechnung',
  'DOCTYPE-026': 'handwerkskammer',
  'DOCTYPE-039': 'brief',
  'DOCTYPE-063': 'mahnung',
  'DOCTYPE-062': 'brief',
  'DOCTYPE-018': 'gutschrift',
  'DOCTYPE-017': 'gutschrift',
  'DOCTYPE-061': 'sonstiges',
  'DOCTYPE-074': 'sonstiges',
};

const FACT_ORDER = {
  contract: ['customer', 'project', 'orderValue', 'site', 'positions', 'gewerk'],
  invoice_in: ['supplier', 'invoiceNumber', 'amount', 'date', 'deadline', 'site'],
  invoice_out: ['customer', 'invoiceNumber', 'amount', 'date', 'vorgang'],
  tank: ['station', 'date', 'amount', 'receipt'],
  delivery: ['supplier', 'date', 'site', 'vorgang', 'qty'],
  authority: ['authority', 'subject', 'reference', 'deadline', 'demand'],
  letter: ['sender', 'subject', 'deadline', 'demand'],
  offer: ['customer', 'subject', 'amount', 'deadline', 'site'],
  generic: ['sender', 'subject', 'amount', 'deadline', 'site'],
};

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadMap(dir, idField = 'id') {
  const map = new Map();
  const folder = join(root, dir);
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.json'))) {
    const row = loadJson(join(folder, file));
    map.set(row[idField], row);
  }
  return map;
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/** Mirrors mapKindToDocumentType + resolveDocumentSummaryFamily (presentation SSOT). */
function documentTypeForKind(kind) {
  const expense = new Set([
    'eingangsrechnung',
    'rechnung',
    'gutschrift',
    'quittung',
    'kassenbeleg',
    'ec_beleg',
    'kreditkartenbeleg',
    'tankbeleg',
    'reparaturrechnung',
  ]);
  const insurance = new Set([
    'betriebshaftpflicht',
    'fahrzeugversicherung',
    'rechtsschutzversicherung',
    'gebaeudeversicherung',
    'versicherungsbescheid',
    'versicherung',
  ]);
  if (kind === 'ausgangsrechnung') return 'ausgangsrechnung';
  if (expense.has(kind) || kind === 'mahnung' || kind === 'zahlungserinnerung') {
    return 'eingangsrechnung';
  }
  if (
    kind === 'werkvertrag' ||
    kind === 'angebot' ||
    kind === 'auftrag' ||
    kind === 'subunternehmervertrag' ||
    kind === 'nachunternehmervertrag' ||
    kind === 'auftragsbestaetigung' ||
    kind === 'lieferschein'
  ) {
    return 'kundenauftrag';
  }
  if (AUTHORITY_KINDS.has(kind) || insurance.has(kind)) return 'behoerde';
  if (kind === 'brief' || kind === 'schriftverkehr' || kind === 'email_pdf') return 'brief';
  return 'sonstiges';
}

function familyForKind(kind) {
  const docType = documentTypeForKind(kind);
  if (kind === 'tankbeleg') return 'tank';
  if (kind === 'lieferschein') return 'delivery';
  if (kind === 'angebot') return 'offer';
  if (kind === 'ausgangsrechnung') return 'invoice_out';
  if (kind === 'eingangsrechnung' || kind === 'rechnung' || docType === 'eingangsrechnung') {
    return 'invoice_in';
  }
  if (AUTHORITY_KINDS.has(kind) || docType === 'behoerde') return 'authority';
  if (kind === 'brief' || kind === 'schriftverkehr' || kind === 'email_pdf' || docType === 'brief') {
    return 'letter';
  }
  if (
    kind === 'werkvertrag' ||
    kind === 'subunternehmervertrag' ||
    kind === 'nachunternehmervertrag' ||
    kind === 'auftrag'
  ) {
    return 'contract';
  }
  return 'generic';
}

function primaryForMatch(status) {
  if (status === 'exact') return 'open_vorgang';
  if (status === 'likely') return 'link_vorgang';
  if (status === 'multiple') return 'select_vorgang';
  return 'create_vorgang';
}

/**
 * U02 / GOLD-FIX-01: caseMatch without artificial known_link.
 * meta.projectId is business context only — not InboxItem.vorgangId.
 * Status = real text match against hydrated Vorgänge (gold fixture RD, no vorgangId).
 * Probe: only DOC-00002 uniquely resolves; other project-linked gold docs are ambiguous.
 */
const TEXT_MATCH_BY_DOC = {
  'DOC-00001': { matchStatus: 'multiple', matchedProjectId: null },
  'DOC-00002': { matchStatus: 'exact', matchedProjectId: 'PRJ-005' },
  'DOC-00003': { matchStatus: 'multiple', matchedProjectId: null },
  'DOC-00004': { matchStatus: 'multiple', matchedProjectId: null },
  'DOC-00005': { matchStatus: 'multiple', matchedProjectId: null },
  'DOC-00031': { matchStatus: 'multiple', matchedProjectId: null },
  'DOC-00032': { matchStatus: 'multiple', matchedProjectId: null },
  'DOC-00033': { matchStatus: 'multiple', matchedProjectId: null },
};

function resolveCaseMatch(meta) {
  const mapped = TEXT_MATCH_BY_DOC[meta.id];
  if (mapped) return mapped;
  // No known_link shortcut: projectId alone never implies exact/open_vorgang.
  return { matchStatus: 'none', matchedProjectId: null };
}

function siteValue(project) {
  if (!project) return undefined;
  const street = project.siteStreet?.trim();
  const city = project.siteCity?.trim();
  if (street && city) return `${street}, ${city}`;
  return project.siteName || project.title;
}

function buildFacts(family, ctx) {
  const order = FACT_ORDER[family];
  const pool = {};

  if (ctx.customerName) {
    pool.customer = ctx.customerName;
  }
  if (ctx.projectTitle) {
    pool.project = ctx.projectTitle;
    pool.vorgang = ctx.projectTitle;
  }
  if (ctx.site) pool.site = ctx.site;
  if (ctx.trade) pool.gewerk = ctx.trade;
  if (ctx.counterpartyName) {
    pool.supplier = ctx.counterpartyName;
    pool.station = ctx.counterpartyName;
    pool.authority = ctx.counterpartyName;
    pool.sender = ctx.counterpartyName;
  }
  if (ctx.date) pool.date = ctx.date;
  if (ctx.subject) pool.subject = ctx.subject;
  if (ctx.employeeName) {
    if (family === 'generic' || family === 'letter' || family === 'authority') {
      pool.subject = pool.subject || ctx.employeeName;
    }
  }
  if (ctx.vehicleLabel) {
    pool.subject = pool.subject || ctx.vehicleLabel;
    pool.reference = ctx.vehiclePlate || ctx.vehicleLabel;
  }

  const facts = [];
  for (const id of order) {
    if (!pool[id]) continue;
    facts.push({ id, value: pool[id] });
    if (facts.length >= 6) break;
  }
  return facts;
}

const taxonomy = loadJson(join(root, 'taxonomy', 'document-taxonomy.json'));
const typeById = new Map(taxonomy.types.map((t) => [t.id, t]));
const customers = loadMap('customers');
const suppliers = loadMap('suppliers');
const employees = loadMap('employees');
const vehicles = loadMap('vehicles');
const projects = loadMap('projects');

const docsDir = join(root, 'documents');
const docFolders = readdirSync(docsDir)
  .filter((name) => name.startsWith('DOC-') && existsSync(join(docsDir, name, 'meta.json')))
  .sort();

let written = 0;

for (const folder of docFolders) {
  const metaPath = join(docsDir, folder, 'meta.json');
  const meta = loadJson(metaPath);
  const leaf = typeById.get(meta.taxonomyTypeId);
  if (!leaf) throw new Error(`Unknown taxonomyTypeId ${meta.taxonomyTypeId} on ${folder}`);
  if (leaf.documentType !== meta.documentType || leaf.subtype !== meta.subtype) {
    throw new Error(`Meta/taxonomy mismatch on ${folder}`);
  }

  const classifiedKind = CLASSIFIED_BY_DOCTYPE[meta.taxonomyTypeId];
  if (!classifiedKind) {
    throw new Error(`No classifiedKind mapping for ${meta.taxonomyTypeId} (${folder})`);
  }
  const family = familyForKind(classifiedKind);

  const customer = meta.customerId ? customers.get(meta.customerId) : null;
  const supplier = meta.supplierId ? suppliers.get(meta.supplierId) : null;
  const employee = meta.employeeId ? employees.get(meta.employeeId) : null;
  const vehicle = meta.vehicleId ? vehicles.get(meta.vehicleId) : null;
  const project = meta.projectId ? projects.get(meta.projectId) : null;

  const { matchStatus, matchedProjectId } = resolveCaseMatch(meta);
  // Reasons are best-effort runtime detail; status + matchedProjectId are the contract.
  const reasons = [];

  const primaryId = primaryForMatch(matchStatus);

  const ctx = {
    customerName: customer?.name,
    counterpartyName: supplier?.name,
    projectTitle: project?.title,
    site: siteValue(project),
    trade: project?.trade,
    date: meta.receivedAt,
    subject: meta.title,
    employeeName: employee ? `${employee.firstName} ${employee.lastName}` : undefined,
    vehicleLabel: vehicle?.label,
    vehiclePlate: vehicle?.licensePlate,
  };

  const classification = {
    documentId: meta.id,
    taxonomyTypeId: meta.taxonomyTypeId,
    documentType: meta.documentType,
    subtype: meta.subtype,
    label: leaf.label,
    classifiedKind,
    family,
  };

  const summary = {
    documentId: meta.id,
    family,
    headline: meta.title,
    factOrder: FACT_ORDER[family],
    facts: buildFacts(family, ctx),
  };

  const caseMatch = {
    documentId: meta.id,
    matchStatus,
    matchedProjectId,
    reasons,
    candidates: [],
  };

  const primaryAction = {
    documentId: meta.id,
    id: primaryId,
  };

  const alerts = {
    documentId: meta.id,
    alertIds: [],
  };

  const expectedDir = join(docsDir, folder, 'expected');
  writeJson(join(expectedDir, 'classification.json'), classification);
  writeJson(join(expectedDir, 'summary.json'), summary);
  writeJson(join(expectedDir, 'caseMatch.json'), caseMatch);
  writeJson(join(expectedDir, 'primaryAction.json'), primaryAction);
  writeJson(join(expectedDir, 'alerts.json'), alerts);

  meta.expected = {
    classifiedKind,
    caseMatchStatus: matchStatus,
    matchedProjectId,
    primaryActionId: primaryId,
    alertIds: [],
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  written += 5;
  console.log('expected', meta.id, classifiedKind, family, matchStatus, primaryId);
}

console.log(
  `Seed 03A complete: ${docFolders.length} documents × 5 expected files = ${written} files (+ meta.expected sync).`,
);
