/**
 * Seed TESTWORLD-IMPLEMENTATION-01D — 10 gold document metas only.
 * Usage: node test-world/_lib/seed-01d-documents.mjs
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = join(root, 'documents');

function writeMeta(id, meta) {
  const dir = join(docsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log('wrote', id);
}

// Clear previous gold docs if re-run (only DOC-00001..00010 folders)
for (let i = 1; i <= 10; i += 1) {
  const id = `DOC-${String(i).padStart(5, '0')}`;
  const dir = join(docsRoot, id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const gold = [
  {
    id: 'DOC-00001',
    companyId: 'COMPANY-001',
    projectId: 'PRJ-001',
    customerId: 'CUST-001',
    taxonomyTypeId: 'DOCTYPE-006',
    documentType: 'contract',
    subtype: 'werkvertrag',
    title: 'Werkvertrag Heizzentrale – Sägewerk Ernst Flisch',
    receivedAt: '2025-09-12',
    lifecyclePhase: 'contract',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: Werkvertrag. Counterparty = Kunde CUST-001 (kein supplierId). Projekt PRJ-001.',
  },
  {
    id: 'DOC-00002',
    companyId: 'COMPANY-001',
    projectId: 'PRJ-005',
    customerId: 'CUST-005',
    taxonomyTypeId: 'DOCTYPE-004',
    documentType: 'offer',
    subtype: 'angebot',
    title: 'Angebot Sanitär – Mehrfamilienhaus Bielefeld',
    receivedAt: '2026-03-08',
    lifecyclePhase: 'offer',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes: 'GOLD: Angebot. Counterparty = Kunde CUST-005. Projekt PRJ-005 (offered).',
  },
  {
    id: 'DOC-00003',
    companyId: 'COMPANY-001',
    projectId: 'PRJ-001',
    customerId: 'CUST-001',
    supplierId: 'SUP-001',
    taxonomyTypeId: 'DOCTYPE-011',
    documentType: 'incoming_invoice',
    subtype: 'material',
    title: 'Eingangsrechnung Material – GC-Großhandel OWL',
    receivedAt: '2026-01-20',
    lifecyclePhase: 'execution',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: Material-ER. Counterparty SUP-001. Baustellenbezug PRJ-001 / CUST-001.',
  },
  {
    id: 'DOC-00004',
    companyId: 'COMPANY-001',
    projectId: 'PRJ-001',
    customerId: 'CUST-001',
    taxonomyTypeId: 'DOCTYPE-014',
    documentType: 'outgoing_invoice',
    subtype: 'abschlag',
    title: 'Ausgangsrechnung Abschlag 1 – Sägewerk Ernst Flisch',
    receivedAt: '2026-02-28',
    lifecyclePhase: 'billing',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes: 'GOLD: Ausgangsrechnung. Counterparty = Kunde CUST-001. Projekt PRJ-001.',
  },
  {
    id: 'DOC-00005',
    companyId: 'COMPANY-001',
    projectId: 'PRJ-001',
    customerId: 'CUST-001',
    supplierId: 'SUP-002',
    taxonomyTypeId: 'DOCTYPE-010',
    documentType: 'delivery_note',
    subtype: 'material',
    title: 'Lieferschein – SanitärPartner Lemgo',
    receivedAt: '2026-01-18',
    lifecyclePhase: 'execution',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes: 'GOLD: Lieferschein. Counterparty SUP-002. Projekt PRJ-001.',
  },
  {
    id: 'DOC-00006',
    companyId: 'COMPANY-001',
    projectId: null,
    supplierId: 'SUP-005',
    employeeId: 'EMP-003',
    vehicleId: 'VEH-001',
    taxonomyTypeId: 'DOCTYPE-019',
    documentType: 'fuel_receipt',
    subtype: 'tankbeleg',
    title: 'Tankbeleg Aral Station Nord – LIP-CH 1001',
    receivedAt: '2026-02-10',
    lifecyclePhase: 'firm',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: Tankbeleg. Nur Fahrzeug VEH-001 (+ Fahrer EMP-003). Kein Projekt. Counterparty SUP-005.',
  },
  {
    id: 'DOC-00007',
    companyId: 'COMPANY-001',
    projectId: null,
    supplierId: 'SUP-006',
    employeeId: 'EMP-004',
    taxonomyTypeId: 'DOCTYPE-020',
    documentType: 'hotel_invoice',
    subtype: 'hotel',
    title: 'Hotelrechnung Lipperland – Übernachtung Monteur',
    receivedAt: '2026-01-25',
    lifecyclePhase: 'firm',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: Hotelrechnung bewusst OHNE Projekt. Counterparty SUP-006. Reisender EMP-004.',
  },
  {
    id: 'DOC-00008',
    companyId: 'COMPANY-001',
    projectId: null,
    supplierId: 'SUP-011',
    taxonomyTypeId: 'DOCTYPE-023',
    documentType: 'authority_letter',
    subtype: 'finanzamt',
    title: 'Finanzamt Detmold – Erinnerung Umsatzsteuer-Voranmeldung',
    receivedAt: '2026-03-01',
    lifecyclePhase: 'firm',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: Finanzamt ausschließlich Firma. Kein Projekt, kein Kunde, kein Fahrzeug. Counterparty SUP-011.',
  },
  {
    id: 'DOC-00009',
    companyId: 'COMPANY-001',
    projectId: null,
    supplierId: 'SUP-012',
    taxonomyTypeId: 'DOCTYPE-022',
    documentType: 'authority_letter',
    subtype: 'bg_bau',
    title: 'BG BAU – Beitragsbescheid',
    receivedAt: '2026-02-15',
    lifecyclePhase: 'firm',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: BG BAU ausschließlich Firma. Kein Projekt, kein Kunde. Counterparty SUP-012.',
  },
  {
    id: 'DOC-00010',
    companyId: 'COMPANY-001',
    projectId: null,
    taxonomyTypeId: 'DOCTYPE-060',
    documentType: 'marketing',
    subtype: 'werbung',
    title: 'Werbung – Werkzeugkatalog Prospekt',
    receivedAt: '2026-03-12',
    lifecyclePhase: 'firm',
    qualityTag: 'clean',
    sourceKind: 'none',
    suiteTags: ['smoke', 'commit', 'release'],
    notes:
      'GOLD: Werbung ohne fachliche Zuordnung. Kein Projekt, Kunde, Counterparty, Mitarbeiter, Fahrzeug.',
  },
];

for (const meta of gold) {
  writeMeta(meta.id, meta);
}

// remove documents/.gitkeep if present
const gk = join(docsRoot, '.gitkeep');
if (existsSync(gk)) {
  const { unlinkSync } = await import('fs');
  unlinkSync(gk);
}

console.log('Seed 01D complete: 10 gold document metas.');
