/**
 * Seed TESTWORLD-IMPLEMENTATION-01C — expanded master data, no documents.
 * Usage: node test-world/_lib/seed-01c.mjs
 */
import { writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function clearJson(dir) {
  const path = join(root, dir);
  for (const file of readdirSync(path)) {
    if (file.endsWith('.json')) unlinkSync(join(path, file));
  }
  const gk = join(path, '.gitkeep');
  if (existsSync(gk)) unlinkSync(gk);
}

function write(dir, id, obj) {
  writeFileSync(join(root, dir, `${id}.json`), `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

for (const dir of [
  'branches',
  'companies',
  'customers',
  'suppliers',
  'employees',
  'vehicles',
  'projects',
]) {
  clearJson(dir);
}

write('companies', 'COMPANY-001', {
  id: 'COMPANY-001',
  legalName: 'Cirmak Haustechnik GmbH',
  tradeName: 'Cirmak Haustechnik',
  street: 'Industriestraße 18',
  zip: '32105',
  city: 'Bad Salzuflen',
  country: 'DE',
  phone: '+49 5222 9800-0',
  email: 'info@cirmak-haustechnik.example',
  website: 'https://www.cirmak-haustechnik.example',
  vatId: 'DE312458790',
  taxNumber: '305/5803/1234',
  commercialRegister: 'HRB 12345 Amtsgericht Lemgo',
  iban: 'DE89 4765 0130 0001 2345 67',
  bic: 'WELADED1LIP',
  bankName: 'Sparkasse Lemgo',
  bgBauMemberNumber: 'BG-OWL-88421',
  sokaBauNumber: 'SOKA-OWL-55210',
  trades: ['Heizung', 'Sanitär', 'Lüftung', 'Klima'],
  defaultBranchId: 'BRANCH-001',
  notes:
    'Referenzfirma TestWorld Phase 1 (SHK). Gewerke stehen auf Company.trades / Project.trade — nicht auf Branch.',
});

write('branches', 'BRANCH-001', {
  id: 'BRANCH-001',
  companyId: 'COMPANY-001',
  name: 'Hauptsitz Bad Salzuflen',
  street: 'Industriestraße 18',
  zip: '32105',
  city: 'Bad Salzuflen',
  country: 'DE',
  phone: '+49 5222 9800-0',
  email: 'office@cirmak-haustechnik.example',
  isHeadquarters: true,
  notes:
    'Standort/Niederlassung. Branch ≠ Gewerk. SHK ist Firmenschwerpunkt (Company.trades), nicht der Branch-Name.',
});

const customers = [
  ['CUST-001', 'Sägewerk Ernst Flisch GmbH', 'industrial', 'Werkstraße 12', '32657', 'Lemgo', 'Ernst Flisch', 'multi-project + matching anchor'],
  ['CUST-002', 'Stadt Lemgo – Gebäudemanagement', 'public', 'Marktplatz 1', '32657', 'Lemgo', 'Frau Vogt', ''],
  ['CUST-003', 'Feuerwehr Bad Salzuflen', 'public', 'Feuerwehrstraße 3', '32105', 'Bad Salzuflen', 'Wehrleitung', 'multi-project'],
  ['CUST-004', 'Wohnpark Herford Projekt GmbH', 'developer', 'Goebenstraße 8', '32052', 'Herford', 'Herr Kramer', 'multi-project'],
  ['CUST-005', 'WEG Mehrfamilienhaus Bielefeld-Mitte', 'housing', 'Niederwall 22', '33602', 'Bielefeld', 'Hausverwaltung Nord', ''],
  ['CUST-006', 'Industriepark Detmold West GmbH', 'industrial', 'Siemensstraße 40', '32756', 'Detmold', 'Technikleitung', ''],
  ['CUST-007', 'Hotel Teutoburger Hof GmbH', 'business', 'Kurparkstraße 5', '32105', 'Bad Salzuflen', 'Frau Stein', ''],
  ['CUST-008', 'Familien Meyer', 'private', 'Birkenweg 7', '32107', 'Bad Salzuflen', 'Thomas Meyer', 'matching anchor'],
  ['CUST-009', 'Ärztehaus Ostwestfalen KG', 'business', 'Bahnhofstraße 15', '32049', 'Herford', 'Praxisverwaltung', ''],
  ['CUST-010', 'Sporthalle Lockhausen e.V.', 'public', 'Sportplatzweg 2', '32107', 'Bad Salzuflen', 'Vorstand Gebäude', ''],
  ['CUST-011', 'Logistikzentrum Lage GmbH', 'industrial', 'Autobahnstraße 1', '32791', 'Lage', 'Betriebsleiter', ''],
  ['CUST-012', 'Grundschule Schötmar', 'public', 'Schulweg 3', '32108', 'Bad Salzuflen', 'Hausmeisterei', ''],
  ['CUST-013', 'Wohnungsbaugesellschaft OWL mbH', 'housing', 'Rathausplatz 2', '32756', 'Detmold', 'Technik', ''],
  ['CUST-014', 'Praxis Dr. Vogt', 'business', 'Lange Str. 40', '32657', 'Lemgo', 'Dr. Vogt', ''],
  ['CUST-015', 'Sägewerk Ernst Flisch & Partner GmbH', 'industrial', 'Werkstraße 14', '32657', 'Lemgo', 'M. Flisch', 'MATCHING-STRESS vs CUST-001'],
  ['CUST-016', 'Familie Meyer', 'private', 'Lindenweg 2', '32107', 'Bad Salzuflen', 'Anna Meyer', 'MATCHING-STRESS vs CUST-008'],
  ['CUST-017', 'Malermeister Bode', 'business', 'Handwerkerweg 9', '32052', 'Herford', 'Herr Bode', 'no project'],
  ['CUST-018', 'Café am Kurpark', 'business', 'Parkstraße 1', '32105', 'Bad Salzuflen', 'Inhaber', 'no project'],
  ['CUST-019', 'Archivkunde Stillstand GmbH', 'business', 'Lagerstraße 8', '33602', 'Bielefeld', 'Buchhaltung', 'no project — archive/search only'],
  ['CUST-020', 'Interessent Neubau Kirchheide', 'private', 'Dorfstraße 11', '32657', 'Lemgo', 'Frau Klein', 'no project — inquiry lead only'],
];

for (const [id, name, customerType, street, zip, city, contactPerson, notes] of customers) {
  write('customers', id, {
    id,
    companyId: 'COMPANY-001',
    name,
    customerType,
    street,
    zip,
    city,
    country: 'DE',
    contactPerson,
    phone: '+49 5000 0000',
    email: `${id.toLowerCase()}@kunde.example`,
    notes: notes || 'TestWorld-Kunde',
  });
}

const suppliers = [
  ['SUP-001', 'GC-Großhandel OWL GmbH', 'wholesale', 'Logistikring 4', '33609', 'Bielefeld', ''],
  ['SUP-002', 'SanitärPartner Lemgo KG', 'wholesale', 'Gewerbepark 9', '32657', 'Lemgo', ''],
  ['SUP-003', 'Heiztechnik Westfalen AG', 'wholesale', 'Industrieweg 21', '32756', 'Detmold', ''],
  ['SUP-004', 'BauMarkt Salzuflen', 'retail', 'Herforder Str. 120', '32105', 'Bad Salzuflen', ''],
  ['SUP-005', 'Aral Station Nord', 'fuel', 'Vlothoer Str. 55', '32105', 'Bad Salzuflen', ''],
  ['SUP-006', 'Hotel Lipperland', 'hotel', 'Parkstraße 10', '32756', 'Detmold', ''],
  ['SUP-007', 'Stadtwerke Bad Salzuflen', 'utility', 'Energieallee 1', '32105', 'Bad Salzuflen', ''],
  ['SUP-008', 'Telekom Geschäftskunden', 'telecom', null, null, 'Bonn', ''],
  ['SUP-009', 'VHV Gewerbeversicherung', 'insurance', 'VHV-Platz 1', '30159', 'Hannover', ''],
  ['SUP-010', 'Alphabet Fuhrparkleasing', 'leasing', null, null, 'München', ''],
  ['SUP-011', 'Finanzamt Detmold', 'authority', 'Büchenstraße 6', '32756', 'Detmold', 'Behörde – USt/Lohn'],
  ['SUP-012', 'BG BAU Bezirksverwaltung OWL', 'authority', null, null, 'Bielefeld', 'Berufsgenossenschaft Bau'],
  ['SUP-013', 'SOKA-BAU', 'authority', 'Wettinerstraße 7', '65189', 'Wiesbaden', 'Sozialkasse Bau'],
  ['SUP-014', 'AOK NordWest', 'health_insurance', null, null, 'Dortmund', 'Krankenkasse'],
  ['SUP-015', 'Sparkasse Lemgo', 'bank', 'Mittelstraße 85', '32657', 'Lemgo', 'Hausbank'],
  ['SUP-016', 'Steuerberatung Ostwestfalen GmbH', 'advisor', 'Bahnhofstraße 2', '32105', 'Bad Salzuflen', 'Steuerberater'],
  ['SUP-017', 'Kanzlei Weber & Partner', 'advisor', 'Markt 4', '32657', 'Lemgo', 'Rechtsanwalt'],
  ['SUP-018', 'OWL Container & Entsorgung GmbH', 'disposal', 'Deponieweg 3', '33609', 'Bielefeld', 'Entsorgung/Container'],
  ['SUP-019', 'Shell Station Ostwestfalen', 'fuel', 'Herforder Str. 200', '32105', 'Bad Salzuflen', 'zweite Tankstelle'],
  ['SUP-020', 'Hotel Teuto View', 'hotel', 'Bergstraße 8', '32657', 'Lemgo', 'zweites Hotel'],
  ['SUP-021', 'Handwerkskammer Ostwestfalen-Lippe zu Bielefeld', 'authority', 'Campus Handwerk 1', '33609', 'Bielefeld', 'HWK – Beitrag/Mitgliedschaft'],
  ['SUP-022', 'Amtsgericht Lemgo', 'authority', 'Rampendal 2', '32657', 'Lemgo', 'Gericht'],
  ['SUP-023', 'Creditreform OWL Inkasso GmbH', 'other', 'Niederwall 15', '33602', 'Bielefeld', 'Inkasso eingehend'],
  ['SUP-024', 'AutoService Teutoburger GmbH', 'other', 'Werkstattweg 7', '32105', 'Bad Salzuflen', 'Werkstatt / TÜV'],
];

for (const [id, name, supplierType, street, zip, city, notes] of suppliers) {
  const row = {
    id,
    companyId: 'COMPANY-001',
    name,
    supplierType,
    city,
    country: 'DE',
    email: `${id.toLowerCase()}@counterparty.example`,
    notes: notes || 'TestWorld-Counterparty',
  };
  if (street) row.street = street;
  if (zip) row.zip = zip;
  write('suppliers', id, row);
}

const employees = [
  ['EMP-001', 'Ahmet', 'Cirmak', 'owner', null],
  ['EMP-002', 'Sandra', 'Keller', 'office', null],
  ['EMP-003', 'Markus', 'Brandt', 'foreman', 'VEH-001'],
  ['EMP-004', 'Jonas', 'Richter', 'technician', 'VEH-002'],
  ['EMP-005', 'Lukas', 'Hoffmann', 'technician', 'VEH-003'],
  ['EMP-006', 'Tim', 'Schulze', 'technician', 'VEH-001'],
  ['EMP-007', 'Nina', 'Bergmann', 'office', null],
  ['EMP-008', 'Paul', 'Neumann', 'apprentice', 'VEH-002'],
  ['EMP-009', 'Omar', 'Yilmaz', 'driver', 'VEH-004'],
  ['EMP-010', 'Eva', 'Krüger', 'foreman', 'VEH-005'],
];

for (const [id, firstName, lastName, role, defaultVehicleId] of employees) {
  const row = {
    id,
    companyId: 'COMPANY-001',
    branchId: 'BRANCH-001',
    firstName,
    lastName,
    role,
    active: true,
    email: `${firstName}.${lastName}@cirmak-haustechnik.example`.toLowerCase(),
    phone: `+49 5222 9800-${id.slice(-2)}`,
    notes: 'TestWorld-Mitarbeiter',
  };
  if (defaultVehicleId) row.defaultVehicleId = defaultVehicleId;
  write('employees', id, row);
}

const vehicles = [
  ['VEH-001', 'Transporter 1', 'LIP-CH 1001', 'van', 'Volkswagen', 'Transporter', 'EMP-003'],
  ['VEH-002', 'Transporter 2', 'LIP-CH 1002', 'van', 'Mercedes-Benz', 'Sprinter', 'EMP-004'],
  ['VEH-003', 'Transporter 3', 'LIP-CH 1003', 'van', 'Ford', 'Transit', 'EMP-005'],
  ['VEH-004', 'Pkw Büro', 'LIP-CH 2001', 'car', 'Skoda', 'Octavia', 'EMP-009'],
  ['VEH-005', 'Transporter 4', 'LIP-CH 1004', 'van', 'Volkswagen', 'Crafter', 'EMP-010'],
];

for (const [id, label, licensePlate, vehicleType, make, model, defaultDriverEmployeeId] of vehicles) {
  write('vehicles', id, {
    id,
    companyId: 'COMPANY-001',
    branchId: 'BRANCH-001',
    label,
    licensePlate,
    vehicleType,
    make,
    model,
    defaultDriverEmployeeId,
    active: true,
    notes: 'TestWorld-Fahrzeug',
  });
}

/** [id, customerId, title, street, zip, city, trade, status, start, end|null, foreman] */
const projects = [
  ['PRJ-001', 'CUST-001', 'Sägewerk Ernst Flisch – Heizzentrale', 'Werkstraße 12', '32657', 'Lemgo', 'Heizung', 'in_progress', '2025-09-01', '2026-06-30', 'EMP-003'],
  ['PRJ-011', 'CUST-001', 'Sägewerk Ernst Flisch – Absaugung Halle 2', 'Werkstraße 12', '32657', 'Lemgo', 'Lüftung', 'commissioned', '2026-02-01', '2026-09-30', 'EMP-005'],
  ['PRJ-012', 'CUST-001', 'Sägewerk Ernst Flisch – Sanitär Bürotrakt', 'Werkstraße 12a', '32657', 'Lemgo', 'Sanitär', 'offered', '2026-04-01', '2026-11-30', 'EMP-004'],
  ['PRJ-002', 'CUST-002', 'Kindergarten Lemgo', 'Schulstraße 4', '32657', 'Lemgo', 'Sanitär', 'commissioned', '2026-01-15', '2026-08-31', 'EMP-010'],
  ['PRJ-003', 'CUST-003', 'Feuerwehr Bad Salzuflen – Gerätehaus', 'Feuerwehrstraße 3', '32105', 'Bad Salzuflen', 'Heizung', 'in_progress', '2025-11-01', '2026-05-15', 'EMP-003'],
  ['PRJ-014', 'CUST-003', 'Feuerwehr Bad Salzuflen – Schulungsraum', 'Feuerwehrstraße 3', '32105', 'Bad Salzuflen', 'Sanitär', 'inquiry', '2026-05-01', null, 'EMP-010'],
  ['PRJ-004', 'CUST-004', 'Wohnpark Herford – Bauabschnitt A', 'Goebenstraße 8', '32052', 'Herford', 'Sanitär', 'in_progress', '2025-08-01', '2026-12-31', 'EMP-010'],
  ['PRJ-013', 'CUST-004', 'Wohnpark Herford – Bauabschnitt B', 'Goebenstraße 12', '32052', 'Herford', 'Heizung', 'commissioned', '2026-03-01', '2027-02-28', 'EMP-003'],
  ['PRJ-005', 'CUST-005', 'Mehrfamilienhaus Bielefeld', 'Niederwall 22', '33602', 'Bielefeld', 'Sanitär', 'offered', '2026-03-01', '2026-10-31', 'EMP-004'],
  ['PRJ-006', 'CUST-006', 'Industriehalle Detmold', 'Siemensstraße 40', '32756', 'Detmold', 'Heizung', 'archived', '2024-02-01', '2025-01-31', 'EMP-003'],
  ['PRJ-007', 'CUST-007', 'Hotel Teutoburger Hof', 'Kurparkstraße 5', '32105', 'Bad Salzuflen', 'Lüftung', 'billed', '2025-04-01', '2025-12-15', 'EMP-005'],
  ['PRJ-008', 'CUST-008', 'EFH Meyer Bad Salzuflen', 'Birkenweg 7', '32107', 'Bad Salzuflen', 'Heizung', 'inquiry', '2026-04-01', null, 'EMP-004'],
  ['PRJ-009', 'CUST-009', 'Ärztehaus Herford', 'Bahnhofstraße 15', '32049', 'Herford', 'Klima', 'disputed', '2025-06-01', '2026-03-31', 'EMP-010'],
  ['PRJ-010', 'CUST-010', 'Sporthalle Lockhausen', 'Sportplatzweg 2', '32107', 'Bad Salzuflen', 'Sanitär', 'warranty', '2024-05-01', '2025-06-30', 'EMP-005'],
  ['PRJ-016', 'CUST-011', 'Logistikzentrum Lage – Sanitärkern', 'Autobahnstraße 1', '32791', 'Lage', 'Sanitär', 'in_progress', '2026-01-10', '2026-10-31', 'EMP-006'],
  ['PRJ-017', 'CUST-012', 'Grundschule Schötmar – Heizungsanlage', 'Schulweg 3', '32108', 'Bad Salzuflen', 'Heizung', 'commissioned', '2026-02-20', '2026-09-15', 'EMP-003'],
  ['PRJ-018', 'CUST-013', 'Wohnungsbau OWL – Detmold Q3', 'Rathausplatz 2', '32756', 'Detmold', 'Sanitär', 'offered', '2026-05-01', '2027-01-31', 'EMP-010'],
  ['PRJ-019', 'CUST-014', 'Praxis Dr. Vogt – Sanitärausstattung', 'Lange Str. 40', '32657', 'Lemgo', 'Sanitär', 'inquiry', '2026-06-01', null, 'EMP-004'],
];

for (const [id, customerId, title, siteStreet, siteZip, siteCity, trade, status, startDate, endDate, foremanEmployeeId] of projects) {
  const row = {
    id,
    companyId: 'COMPANY-001',
    branchId: 'BRANCH-001',
    customerId,
    title,
    siteName: title,
    siteStreet,
    siteZip,
    siteCity,
    trade,
    status,
    startDate,
    foremanEmployeeId,
    timelineDocumentIds: [],
    notes: 'TestWorld-Projekt 01C – noch ohne Dokumente',
  };
  if (endDate) row.endDate = endDate;
  write('projects', id, row);
}

console.log('Seed 01C complete.');
console.log({
  companies: 1,
  branches: 1,
  customers: customers.length,
  suppliers: suppliers.length,
  employees: employees.length,
  vehicles: vehicles.length,
  projects: projects.length,
  documents: 0,
});
