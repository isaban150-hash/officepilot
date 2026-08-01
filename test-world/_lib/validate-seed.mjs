/**
 * One-shot schema + referential + taxonomy check for seeded JSON.
 * Usage: node test-world/_lib/validate-seed.mjs
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const map = {
  branches: 'branch.schema.json',
  companies: 'company.schema.json',
  customers: 'customer.schema.json',
  suppliers: 'supplier.schema.json',
  employees: 'employee.schema.json',
  vehicles: 'vehicle.schema.json',
  projects: 'project.schema.json',
};

let failed = 0;
let total = 0;

function loadIds(dir) {
  return new Set(
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, '')),
  );
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

for (const [dir, schemaFile] of Object.entries(map)) {
  const schema = JSON.parse(readFileSync(join(root, 'schemas', schemaFile), 'utf8'));
  const validate = ajv.compile(schema);
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    total += 1;
    const data = JSON.parse(readFileSync(join(root, dir, file), 'utf8'));
    if (!validate(data)) {
      failed += 1;
      console.error('FAIL', `${dir}/${file}`, validate.errors);
    }
  }
  console.log(`${dir}: ${files.length}`);
}

const taxonomyPath = join(root, 'taxonomy', 'document-taxonomy.json');
const taxonomySchema = JSON.parse(
  readFileSync(join(root, 'schemas', 'document-taxonomy.schema.json'), 'utf8'),
);
const validateTaxonomy = ajv.compile(taxonomySchema);
const taxonomy = JSON.parse(readFileSync(taxonomyPath, 'utf8'));
total += 1;
if (!validateTaxonomy(taxonomy)) {
  failed += 1;
  console.error('FAIL taxonomy/document-taxonomy.json', validateTaxonomy.errors);
} else {
  console.log(
    `taxonomy: groups=${taxonomy.groups.length} documentTypes=${taxonomy.documentTypes.length} types=${taxonomy.types.length}`,
  );
}

const groupIds = new Set(taxonomy.groups.map((g) => g.id));
const groupKeys = new Set();
for (const g of taxonomy.groups) {
  if (groupKeys.has(g.key)) {
    failed += 1;
    console.error('FAIL duplicate group key', g.key);
  }
  groupKeys.add(g.key);
}

const docTypeKeys = new Set(taxonomy.documentTypes.map((d) => d.key));
const typeById = new Map();
const typePair = new Set();
for (const t of taxonomy.types) {
  if (typeById.has(t.id)) {
    failed += 1;
    console.error('FAIL duplicate DOCTYPE id', t.id);
  }
  typeById.set(t.id, t);
  const pair = `${t.documentType}::${t.subtype}`;
  if (typePair.has(pair)) {
    failed += 1;
    console.error('FAIL duplicate documentType/subtype', pair);
  }
  typePair.add(pair);
  if (!groupIds.has(t.groupId)) {
    failed += 1;
    console.error('FAIL unknown groupId', t.id, t.groupId);
  }
  if (!docTypeKeys.has(t.documentType)) {
    failed += 1;
    console.error('FAIL unknown documentType key', t.id, t.documentType);
  }
}

const docSchema = JSON.parse(readFileSync(join(root, 'schemas', 'document.schema.json'), 'utf8'));
const validateDoc = ajv.compile(docSchema);
const companyIds = loadIds('companies');
const customerIds = loadIds('customers');
const supplierIds = loadIds('suppliers');
const employeeIds = loadIds('employees');
const vehicleIds = loadIds('vehicles');
const projectIds = loadIds('projects');

const docsDir = join(root, 'documents');
const docFolders = existsSync(docsDir)
  ? readdirSync(docsDir).filter((name) => {
      const p = join(docsDir, name);
      return statSync(p).isDirectory() && name.startsWith('DOC-');
    })
  : [];

const FIELD_TO_REL = {
  projectId: 'project',
  customerId: 'customer',
  supplierId: 'counterparty',
  employeeId: 'employee',
  vehicleId: 'vehicle',
};

for (const folder of docFolders) {
  const metaPath = join(docsDir, folder, 'meta.json');
  if (!existsSync(metaPath)) {
    failed += 1;
    console.error('FAIL missing meta.json', folder);
    continue;
  }
  total += 1;
  const data = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!validateDoc(data)) {
    failed += 1;
    console.error('FAIL', `documents/${folder}/meta.json`, validateDoc.errors);
    continue;
  }
  if (data.id !== folder) {
    failed += 1;
    console.error('FAIL id/folder mismatch', folder, data.id);
  }
  if (!companyIds.has(data.companyId)) {
    failed += 1;
    console.error('FAIL bad companyId', folder, data.companyId);
  }
  if (data.projectId != null && !projectIds.has(data.projectId)) {
    failed += 1;
    console.error('FAIL bad projectId', folder, data.projectId);
  }
  if (data.customerId && !customerIds.has(data.customerId)) {
    failed += 1;
    console.error('FAIL bad customerId', folder, data.customerId);
  }
  if (data.supplierId && !supplierIds.has(data.supplierId)) {
    failed += 1;
    console.error('FAIL bad supplierId', folder, data.supplierId);
  }
  if (data.employeeId && !employeeIds.has(data.employeeId)) {
    failed += 1;
    console.error('FAIL bad employeeId', folder, data.employeeId);
  }
  if (data.vehicleId && !vehicleIds.has(data.vehicleId)) {
    failed += 1;
    console.error('FAIL bad vehicleId', folder, data.vehicleId);
  }

  const leaf = typeById.get(data.taxonomyTypeId);
  if (!leaf) {
    failed += 1;
    console.error('FAIL unknown taxonomyTypeId', folder, data.taxonomyTypeId);
    continue;
  }
  if (leaf.documentType !== data.documentType || leaf.subtype !== data.subtype) {
    failed += 1;
    console.error(
      'FAIL taxonomy mismatch',
      folder,
      data.taxonomyTypeId,
      `${data.documentType}/${data.subtype}`,
      `expected ${leaf.documentType}/${leaf.subtype}`,
    );
  }

  for (const field of leaf.fields.required) {
    if (field === 'projectId') {
      if (data.projectId == null) {
        failed += 1;
        console.error('FAIL required projectId missing', folder, leaf.id);
      }
    } else if (!present(data[field])) {
      failed += 1;
      console.error('FAIL required field missing', folder, leaf.id, field);
    }
  }

  for (const field of leaf.fields.forbidden) {
    if (field === 'projectId') {
      if (data.projectId != null) {
        failed += 1;
        console.error('FAIL forbidden projectId set', folder, leaf.id, data.projectId);
      }
    } else if (present(data[field])) {
      failed += 1;
      console.error('FAIL forbidden field set', folder, leaf.id, field, data[field]);
    }
  }

  for (const [field, relKey] of Object.entries(FIELD_TO_REL)) {
    const rule = leaf.relations[relKey];
    const isSet = field === 'projectId' ? data.projectId != null : present(data[field]);
    if (rule === 'forbidden' && isSet) {
      failed += 1;
      console.error('FAIL relation forbidden', folder, leaf.id, field);
    }
    if (rule === 'required' && !isSet) {
      failed += 1;
      console.error('FAIL relation required', folder, leaf.id, field);
    }
  }
}

const expectedFiles = [
  ['classification.json', 'expected-classification.schema.json'],
  ['summary.json', 'expected-summary.schema.json'],
  ['caseMatch.json', 'expected-caseMatch.schema.json'],
  ['primaryAction.json', 'expected-primaryAction.schema.json'],
  ['alerts.json', 'expected-alerts.schema.json'],
];
const expectedValidators = new Map();
for (const [file, schemaFile] of expectedFiles) {
  const schema = JSON.parse(readFileSync(join(root, 'schemas', schemaFile), 'utf8'));
  expectedValidators.set(file, ajv.compile(schema));
}

let expectedCount = 0;
const PRIMARY_BY_STATUS = {
  exact: 'open_vorgang',
  likely: 'link_vorgang',
  multiple: 'select_vorgang',
  none: 'create_vorgang',
};

for (const folder of docFolders) {
  const meta = JSON.parse(readFileSync(join(docsDir, folder, 'meta.json'), 'utf8'));
  const expectedDir = join(docsDir, folder, 'expected');
  const bundle = {};

  for (const [file, ] of expectedFiles) {
    const path = join(expectedDir, file);
    if (!existsSync(path)) {
      failed += 1;
      console.error('FAIL missing expected', folder, file);
      continue;
    }
    total += 1;
    expectedCount += 1;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const validate = expectedValidators.get(file);
    if (!validate(data)) {
      failed += 1;
      console.error('FAIL', `documents/${folder}/expected/${file}`, validate.errors);
      continue;
    }
    if (data.documentId !== folder) {
      failed += 1;
      console.error('FAIL expected documentId mismatch', folder, file, data.documentId);
    }
    bundle[file] = data;
  }

  const classification = bundle['classification.json'];
  const summary = bundle['summary.json'];
  const caseMatch = bundle['caseMatch.json'];
  const primaryAction = bundle['primaryAction.json'];
  const alerts = bundle['alerts.json'];
  if (!classification || !summary || !caseMatch || !primaryAction || !alerts) continue;

  if (
    classification.taxonomyTypeId !== meta.taxonomyTypeId ||
    classification.documentType !== meta.documentType ||
    classification.subtype !== meta.subtype
  ) {
    failed += 1;
    console.error('FAIL expected classification≠meta taxonomy', folder);
  }

  if (summary.family !== classification.family) {
    failed += 1;
    console.error('FAIL summary family≠classification family', folder);
  }

  const orderIndex = new Map(summary.factOrder.map((id, i) => [id, i]));
  let last = -1;
  for (const fact of summary.facts) {
    if (!orderIndex.has(fact.id)) {
      failed += 1;
      console.error('FAIL fact id not in factOrder', folder, fact.id);
      continue;
    }
    const idx = orderIndex.get(fact.id);
    if (idx < last) {
      failed += 1;
      console.error('FAIL fact order violated', folder, fact.id);
    }
    last = idx;
  }

  if (meta.projectId == null) {
    if (caseMatch.matchStatus !== 'none' || caseMatch.matchedProjectId != null) {
      failed += 1;
      console.error('FAIL firm doc must have caseMatch none', folder);
    }
  } else if (
    caseMatch.matchStatus !== 'exact' ||
    caseMatch.matchedProjectId !== meta.projectId
  ) {
    failed += 1;
    console.error('FAIL project doc caseMatch', folder, caseMatch);
  }

  const expectedPrimary = PRIMARY_BY_STATUS[caseMatch.matchStatus];
  if (primaryAction.id !== expectedPrimary) {
    failed += 1;
    console.error(
      'FAIL primaryAction≠caseMatch rule',
      folder,
      primaryAction.id,
      'expected',
      expectedPrimary,
    );
  }

  if (meta.expected) {
    if (
      meta.expected.classifiedKind !== classification.classifiedKind ||
      meta.expected.caseMatchStatus !== caseMatch.matchStatus ||
      meta.expected.matchedProjectId !== caseMatch.matchedProjectId ||
      meta.expected.primaryActionId !== primaryAction.id
    ) {
      failed += 1;
      console.error('FAIL meta.expected out of sync', folder);
    }
  }

  const pdfPath = join(docsDir, folder, 'source.pdf');
  const jpgPath = join(docsDir, folder, 'source.jpg');
  if (!existsSync(pdfPath) || statSync(pdfPath).size < 500) {
    failed += 1;
    console.error('FAIL missing/empty source.pdf', folder);
  } else {
    total += 1;
  }
  if (!existsSync(jpgPath) || statSync(jpgPath).size < 500) {
    failed += 1;
    console.error('FAIL missing/empty source.jpg', folder);
  } else {
    total += 1;
  }
  if (meta.sourceFile !== 'source.pdf' || meta.sourceKind !== 'pdf') {
    failed += 1;
    console.error('FAIL meta sourceFile/sourceKind', folder, meta.sourceFile, meta.sourceKind);
  }
}

console.log(`documents: ${docFolders.length}`);
console.log(`expected files: ${expectedCount}`);
console.log(`total=${total} failed=${failed}`);
if (failed) process.exit(1);
