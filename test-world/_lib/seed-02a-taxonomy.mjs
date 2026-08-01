/**
 * TESTWORLD-IMPLEMENTATION-02A — write frozen document taxonomy.
 * Usage: node test-world/_lib/seed-02a-taxonomy.mjs
 *
 * Policy after this sprint: IDs/keys may only be extended, never renamed/removed.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const R = {
  /** project, company, employee, vehicle, customer, counterparty, unassigned */
  firmCounterparty: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  projectCustomer: {
    project: 'required',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'required',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  typicalProjectCustomer: {
    project: 'typical',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'required',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  hrEmployee: {
    project: 'forbidden',
    company: 'required',
    employee: 'required',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  unassignedOnly: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'forbidden',
    unassigned: 'allowed',
  },
};

function F(required = [], optional = [], forbidden = []) {
  return { required, optional, forbidden };
}

const groups = [
  ['DOCGROUP-001', 'auftrag', 'Auftrag', 'Kundenauftrag / Auftragsbestätigung'],
  ['DOCGROUP-002', 'angebot', 'Angebot', 'Angebote und Nachtragsangebote an Kunden'],
  ['DOCGROUP-003', 'vertrag', 'Vertrag', 'Werk- und Dienstleistungsverträge'],
  ['DOCGROUP-004', 'nachtrag', 'Nachtrag', 'Vertragsänderungen und Nachträge'],
  ['DOCGROUP-005', 'lieferschein', 'Lieferschein', 'Wareneingang/-ausgang Lieferscheine'],
  ['DOCGROUP-006', 'eingangsrechnung', 'Eingangsrechnung', 'Kreditorenrechnungen'],
  ['DOCGROUP-007', 'ausgangsrechnung', 'Ausgangsrechnung', 'Debitorenrechnungen'],
  ['DOCGROUP-008', 'gutschrift', 'Gutschrift', 'Gutschriften Kunde oder Lieferant'],
  ['DOCGROUP-009', 'tankbeleg', 'Tankbeleg', 'Kraftstoffbelege Fuhrpark'],
  ['DOCGROUP-010', 'hotelrechnung', 'Hotelrechnung', 'Übernachtung Außendienst'],
  ['DOCGROUP-011', 'behoerden', 'Behörden', 'Allgemeine Behördenkorrespondenz'],
  ['DOCGROUP-012', 'bg_bau', 'BG BAU', 'Berufsgenossenschaft Bau'],
  ['DOCGROUP-013', 'finanzamt', 'Finanzamt', 'Steuerbehörde'],
  ['DOCGROUP-014', 'krankenkasse', 'Krankenkasse', 'Gesetzliche Krankenversicherung / Beiträge'],
  ['DOCGROUP-015', 'hwk', 'HWK', 'Handwerkskammer'],
  ['DOCGROUP-016', 'ihk', 'IHK', 'Industrie- und Handelskammer'],
  ['DOCGROUP-017', 'versicherungen', 'Versicherungen', 'Betriebs- und Sachversicherungen'],
  ['DOCGROUP-018', 'banken', 'Banken', 'Bank- und Finanzierungskorrespondenz'],
  ['DOCGROUP-019', 'steuerberater', 'Steuerberater', 'Steuerberatung und Buchhaltungsextern'],
  ['DOCGROUP-020', 'rechtsanwalt', 'Rechtsanwalt', 'Anwaltskorrespondenz und -rechnungen'],
  ['DOCGROUP-021', 'energie', 'Energie', 'Strom, Gas, Wasser, Wärme'],
  ['DOCGROUP-022', 'telekommunikation', 'Telekommunikation', 'Mobilfunk, Internet, Festnetz'],
  ['DOCGROUP-023', 'fahrzeuge', 'Fahrzeuge', 'Fuhrpark ohne Tankbeleg'],
  ['DOCGROUP-024', 'personal', 'Personal', 'HR- und Mitarbeiterdokumente'],
  ['DOCGROUP-025', 'marketing', 'Marketing', 'Eigenes Marketing / Kampagnen'],
  ['DOCGROUP-026', 'werbung', 'Werbung', 'Fremdwerbung / Prospekte'],
  ['DOCGROUP-027', 'spam', 'Spam', 'Unerwünschte / irrelevante Post'],
  ['DOCGROUP-028', 'sonstige', 'Sonstige', 'Restklasse und Baustellennebenarten'],
  ['DOCGROUP-029', 'gericht', 'Gericht', 'Gerichtsunterlagen'],
  ['DOCGROUP-030', 'inkasso', 'Inkasso', 'Inkasso ein- und ausgehend'],
  ['DOCGROUP-031', 'datenschutz', 'Datenschutz', 'DSGVO / AV-Verträge / Datenschutz'],
];

const documentTypes = [
  ['inquiry', 'Anfrage', 'Kunden- oder Lieferantenanfrage'],
  ['offer', 'Angebot', 'Angebot an Kunden'],
  ['order_confirmation', 'Auftrag', 'Auftrag / Auftragsbestätigung'],
  ['contract', 'Vertrag', 'Vertragswerk'],
  ['amendment', 'Nachtrag', 'Vertragsnachtrag'],
  ['delivery_note', 'Lieferschein', 'Lieferschein'],
  ['incoming_invoice', 'Eingangsrechnung', 'Eingangsrechnung'],
  ['outgoing_invoice', 'Ausgangsrechnung', 'Ausgangsrechnung'],
  ['credit_note', 'Gutschrift', 'Gutschrift'],
  ['fuel_receipt', 'Tankbeleg', 'Kraftstoffbeleg'],
  ['hotel_invoice', 'Hotelrechnung', 'Hotelrechnung'],
  ['authority_letter', 'Behörde', 'Behörden-/Kammer-/SV-Schreiben'],
  ['insurance_letter', 'Versicherung', 'Versicherungspolice/-rechnung/-schreiben'],
  ['bank_letter', 'Bank', 'Bankdokument'],
  ['advisor_letter', 'Berater', 'Steuerberater o. ä.'],
  ['legal_letter', 'Recht', 'Anwalt / Gericht / Inkasso / Datenschutz'],
  ['utility', 'Energie', 'Versorgerrechnung'],
  ['telecom', 'Telekommunikation', 'Telco-Rechnung'],
  ['vehicle_document', 'Fahrzeugdokument', 'Fuhrparkdokument'],
  ['hr', 'Personal', 'HR-Dokument'],
  ['payment_reminder', 'Zahlungserinnerung', 'Zahlungserinnerung'],
  ['dunning', 'Mahnung', 'Mahnung'],
  ['acceptance', 'Abnahme', 'Abnahmeprotokoll'],
  ['inspection_protocol', 'Protokoll', 'Prüf-/Aufmaßprotokoll'],
  ['site_diary', 'Bautagebuch', 'Bautagebuch / Tagesbericht'],
  ['photo', 'Foto', 'Fotodokumentation'],
  ['marketing', 'Marketing', 'Marketingmaterial'],
  ['spam', 'Spam', 'Spam / Phishing / irrelevant'],
  ['other', 'Sonstige', 'Nicht näher klassifiziert'],
];

/** @type {Array<Record<string, unknown>>} */
const types = [];

function add(row) {
  types.push(row);
}

add({
  id: 'DOCTYPE-001',
  documentType: 'inquiry',
  subtype: 'anfrage',
  label: 'Anfrage',
  groupId: 'DOCGROUP-001',
  defaultLifecyclePhase: 'inquiry',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'typical',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  fields: F(['customerId'], ['projectId'], ['supplierId', 'employeeId', 'vehicleId']),
  notes: 'Kundenanfrage; Projekt oft noch nicht vorhanden.',
});

add({
  id: 'DOCTYPE-002',
  documentType: 'order_confirmation',
  subtype: 'auftrag',
  label: 'Auftrag',
  groupId: 'DOCGROUP-001',
  defaultLifecyclePhase: 'contract',
  relations: R.typicalProjectCustomer,
  fields: F(['customerId'], ['projectId'], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-003',
  documentType: 'order_confirmation',
  subtype: 'auftragsbestaetigung_kunde',
  label: 'Auftragsbestätigung Kunde',
  groupId: 'DOCGROUP-001',
  defaultLifecyclePhase: 'contract',
  relations: R.typicalProjectCustomer,
  fields: F(['customerId'], ['projectId'], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-004',
  documentType: 'offer',
  subtype: 'angebot',
  label: 'Angebot',
  groupId: 'DOCGROUP-002',
  defaultLifecyclePhase: 'offer',
  relations: R.typicalProjectCustomer,
  fields: F(['customerId'], ['projectId'], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-005',
  documentType: 'offer',
  subtype: 'nachtragsangebot',
  label: 'Nachtragsangebot',
  groupId: 'DOCGROUP-002',
  defaultLifecyclePhase: 'offer',
  relations: R.projectCustomer,
  fields: F(['projectId', 'customerId'], [], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-006',
  documentType: 'contract',
  subtype: 'werkvertrag',
  label: 'Werkvertrag',
  groupId: 'DOCGROUP-003',
  defaultLifecyclePhase: 'contract',
  relations: R.projectCustomer,
  fields: F(['projectId', 'customerId'], [], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-007',
  documentType: 'contract',
  subtype: 'dienstleistungsvertrag',
  label: 'Dienstleistungsvertrag',
  groupId: 'DOCGROUP-003',
  defaultLifecyclePhase: 'contract',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'typical',
    counterparty: 'optional',
    unassigned: 'forbidden',
  },
  fields: F([], ['projectId', 'customerId', 'supplierId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-008',
  documentType: 'contract',
  subtype: 'subunternehmervertrag',
  label: 'Subunternehmervertrag',
  groupId: 'DOCGROUP-003',
  defaultLifecyclePhase: 'contract',
  relations: {
    project: 'typical',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-009',
  documentType: 'amendment',
  subtype: 'nachtrag',
  label: 'Nachtrag',
  groupId: 'DOCGROUP-004',
  defaultLifecyclePhase: 'contract',
  relations: R.projectCustomer,
  fields: F(['projectId', 'customerId'], [], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-010',
  documentType: 'delivery_note',
  subtype: 'material',
  label: 'Lieferschein Material',
  groupId: 'DOCGROUP-005',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'typical',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-011',
  documentType: 'incoming_invoice',
  subtype: 'material',
  label: 'Eingangsrechnung Material',
  groupId: 'DOCGROUP-006',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'typical',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-012',
  documentType: 'incoming_invoice',
  subtype: 'subunternehmer',
  label: 'Eingangsrechnung Subunternehmer',
  groupId: 'DOCGROUP-006',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'required',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['projectId', 'supplierId'], ['customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-013',
  documentType: 'incoming_invoice',
  subtype: 'betrieb',
  label: 'Eingangsrechnung Betrieb',
  groupId: 'DOCGROUP-006',
  defaultLifecyclePhase: 'firm',
  relations: R.firmCounterparty,
  fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
  notes: 'Allgemeine Betriebsausgaben ohne Baustelle.',
});

for (const [id, subtype, label] of [
  ['DOCTYPE-014', 'abschlag', 'Ausgangsrechnung Abschlag'],
  ['DOCTYPE-015', 'schlussrechnung', 'Schlussrechnung'],
  ['DOCTYPE-016', 'rechnung', 'Ausgangsrechnung'],
]) {
  add({
    id,
    documentType: 'outgoing_invoice',
    subtype,
    label,
    groupId: 'DOCGROUP-007',
    defaultLifecyclePhase: 'billing',
    relations: R.projectCustomer,
    fields: F(['projectId', 'customerId'], [], ['supplierId', 'employeeId', 'vehicleId']),
  });
}

add({
  id: 'DOCTYPE-017',
  documentType: 'credit_note',
  subtype: 'gutschrift_kunde',
  label: 'Gutschrift an Kunde',
  groupId: 'DOCGROUP-008',
  defaultLifecyclePhase: 'billing',
  relations: R.projectCustomer,
  fields: F(['projectId', 'customerId'], [], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-018',
  documentType: 'credit_note',
  subtype: 'gutschrift_lieferant',
  label: 'Gutschrift vom Lieferanten',
  groupId: 'DOCGROUP-008',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-019',
  documentType: 'fuel_receipt',
  subtype: 'tankbeleg',
  label: 'Tankbeleg',
  groupId: 'DOCGROUP-009',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'typical',
    vehicle: 'required',
    customer: 'forbidden',
    counterparty: 'typical',
    unassigned: 'forbidden',
  },
  fields: F(['vehicleId'], ['employeeId', 'supplierId'], ['projectId', 'customerId']),
  notes: 'Kein Projekt. Primär Fahrzeug; Fahrer optional.',
});

add({
  id: 'DOCTYPE-020',
  documentType: 'hotel_invoice',
  subtype: 'hotel',
  label: 'Hotelrechnung',
  groupId: 'DOCGROUP-010',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'optional',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['employeeId'], ['projectId', 'customerId', 'vehicleId']),
  notes: 'Standard: kein Projekt erzwingen / zuordnen.',
});

for (const [id, subtype, label, groupId, empOptional] of [
  ['DOCTYPE-021', 'behoerde_allgemein', 'Behördenschreiben', 'DOCGROUP-011', false],
  ['DOCTYPE-022', 'bg_bau', 'BG BAU', 'DOCGROUP-012', false],
  ['DOCTYPE-023', 'finanzamt', 'Finanzamt', 'DOCGROUP-013', false],
  ['DOCTYPE-024', 'krankenkasse', 'Krankenkasse', 'DOCGROUP-014', true],
  ['DOCTYPE-025', 'soka_bau', 'SOKA-Bau', 'DOCGROUP-011', false],
  ['DOCTYPE-026', 'hwk', 'HWK', 'DOCGROUP-015', false],
  ['DOCTYPE-027', 'ihk', 'IHK', 'DOCGROUP-016', false],
  ['DOCTYPE-028', 'gewerbeamt', 'Gewerbeamt', 'DOCGROUP-011', false],
]) {
  add({
    id,
    documentType: 'authority_letter',
    subtype,
    label,
    groupId,
    defaultLifecyclePhase: 'firm',
    relations: {
      ...R.firmCounterparty,
      employee: empOptional ? 'optional' : 'forbidden',
    },
    fields: F(
      ['supplierId'],
      empOptional ? ['employeeId'] : [],
      empOptional
        ? ['projectId', 'customerId', 'vehicleId']
        : ['projectId', 'customerId', 'employeeId', 'vehicleId'],
    ),
  });
}

for (const [id, subtype, label, projectRel] of [
  ['DOCTYPE-029', 'betriebshaftpflicht', 'Betriebshaftpflicht', 'forbidden'],
  ['DOCTYPE-030', 'inhaltsversicherung', 'Inhaltsversicherung', 'forbidden'],
  ['DOCTYPE-031', 'bauleistung', 'Bauleistungsversicherung', 'typical'],
  ['DOCTYPE-032', 'versicherung_allgemein', 'Versicherung allgemein', 'forbidden'],
]) {
  const withProject = projectRel !== 'forbidden';
  add({
    id,
    documentType: 'insurance_letter',
    subtype,
    label,
    groupId: 'DOCGROUP-017',
    defaultLifecyclePhase: withProject ? 'execution' : 'firm',
    relations: {
      project: projectRel,
      company: 'required',
      employee: 'forbidden',
      vehicle: 'forbidden',
      customer: withProject ? 'optional' : 'forbidden',
      counterparty: 'required',
      unassigned: 'forbidden',
    },
    fields: F(
      ['supplierId'],
      withProject ? ['projectId', 'customerId'] : [],
      withProject
        ? ['employeeId', 'vehicleId']
        : ['projectId', 'customerId', 'employeeId', 'vehicleId'],
    ),
  });
}

add({
  id: 'DOCTYPE-033',
  documentType: 'bank_letter',
  subtype: 'kontoauszug',
  label: 'Kontoauszug',
  groupId: 'DOCGROUP-018',
  defaultLifecyclePhase: 'firm',
  relations: R.firmCounterparty,
  fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-034',
  documentType: 'bank_letter',
  subtype: 'kredit',
  label: 'Kredit / Darlehen',
  groupId: 'DOCGROUP-018',
  defaultLifecyclePhase: 'firm',
  relations: R.firmCounterparty,
  fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-035',
  documentType: 'bank_letter',
  subtype: 'buergschaft',
  label: 'Bürgschaft / Aval',
  groupId: 'DOCGROUP-018',
  defaultLifecyclePhase: 'contract',
  relations: {
    project: 'typical',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-036',
  documentType: 'advisor_letter',
  subtype: 'steuerberater_rechnung',
  label: 'Steuerberater-Rechnung',
  groupId: 'DOCGROUP-019',
  defaultLifecyclePhase: 'firm',
  relations: R.firmCounterparty,
  fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-037',
  documentType: 'advisor_letter',
  subtype: 'steuerberater_schreiben',
  label: 'Steuerberater-Schreiben',
  groupId: 'DOCGROUP-019',
  defaultLifecyclePhase: 'firm',
  relations: R.firmCounterparty,
  fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

for (const [id, subtype, label] of [
  ['DOCTYPE-038', 'rechtsanwalt_rechnung', 'Rechtsanwalt-Rechnung'],
  ['DOCTYPE-039', 'rechtsanwalt_schreiben', 'Rechtsanwalt-Schreiben'],
]) {
  add({
    id,
    documentType: 'legal_letter',
    subtype,
    label,
    groupId: 'DOCGROUP-020',
    defaultLifecyclePhase: 'firm',
    relations: {
      project: 'optional',
      company: 'required',
      employee: 'forbidden',
      vehicle: 'forbidden',
      customer: 'optional',
      counterparty: 'required',
      unassigned: 'forbidden',
    },
    fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
  });
}

for (const [id, subtype, label] of [
  ['DOCTYPE-040', 'strom', 'Stromrechnung'],
  ['DOCTYPE-041', 'gas', 'Gasrechnung'],
  ['DOCTYPE-042', 'wasser', 'Wasserrechnung'],
]) {
  add({
    id,
    documentType: 'utility',
    subtype,
    label,
    groupId: 'DOCGROUP-021',
    defaultLifecyclePhase: 'firm',
    relations: R.firmCounterparty,
    fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
  });
}

add({
  id: 'DOCTYPE-043',
  documentType: 'telecom',
  subtype: 'mobilfunk',
  label: 'Mobilfunkrechnung',
  groupId: 'DOCGROUP-022',
  defaultLifecyclePhase: 'firm',
  relations: {
    ...R.firmCounterparty,
    employee: 'optional',
  },
  fields: F(['supplierId'], ['employeeId'], ['projectId', 'customerId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-044',
  documentType: 'telecom',
  subtype: 'internet',
  label: 'Internet / Festnetz',
  groupId: 'DOCGROUP-022',
  defaultLifecyclePhase: 'firm',
  relations: R.firmCounterparty,
  fields: F(['supplierId'], [], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-045',
  documentType: 'vehicle_document',
  subtype: 'kfz_versicherung',
  label: 'Kfz-Versicherung',
  groupId: 'DOCGROUP-023',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'required',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['vehicleId', 'supplierId'], ['employeeId'], ['projectId', 'customerId']),
});

add({
  id: 'DOCTYPE-046',
  documentType: 'vehicle_document',
  subtype: 'leasing',
  label: 'Leasing',
  groupId: 'DOCGROUP-023',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'typical',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['vehicleId', 'employeeId'], ['projectId', 'customerId']),
});

add({
  id: 'DOCTYPE-047',
  documentType: 'vehicle_document',
  subtype: 'tuev',
  label: 'TÜV / HU / AU',
  groupId: 'DOCGROUP-023',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'required',
    customer: 'forbidden',
    counterparty: 'typical',
    unassigned: 'forbidden',
  },
  fields: F(['vehicleId'], ['supplierId', 'employeeId'], ['projectId', 'customerId']),
});

add({
  id: 'DOCTYPE-048',
  documentType: 'vehicle_document',
  subtype: 'werkstatt',
  label: 'Werkstattrechnung',
  groupId: 'DOCGROUP-023',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'required',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['vehicleId', 'supplierId'], ['employeeId'], ['projectId', 'customerId']),
});

add({
  id: 'DOCTYPE-049',
  documentType: 'vehicle_document',
  subtype: 'kfz_steuer',
  label: 'Kfz-Steuer',
  groupId: 'DOCGROUP-023',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'required',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['vehicleId', 'supplierId'], [], ['projectId', 'customerId', 'employeeId']),
});

add({
  id: 'DOCTYPE-050',
  documentType: 'vehicle_document',
  subtype: 'bussgeld',
  label: 'Bußgeld / Knöllchen',
  groupId: 'DOCGROUP-023',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'optional',
    vehicle: 'required',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['vehicleId', 'supplierId'], ['employeeId'], ['projectId', 'customerId']),
});

for (const [id, subtype, label] of [
  ['DOCTYPE-051', 'arbeitsvertrag', 'Arbeitsvertrag'],
  ['DOCTYPE-053', 'kuendigung', 'Kündigung'],
  ['DOCTYPE-055', 'urlaub', 'Urlaub'],
  ['DOCTYPE-058', 'arbeitszeugnis', 'Arbeitszeugnis'],
]) {
  add({
    id,
    documentType: 'hr',
    subtype,
    label,
    groupId: 'DOCGROUP-024',
    defaultLifecyclePhase: 'firm',
    relations: R.hrEmployee,
    fields: F(['employeeId'], [], ['projectId', 'customerId', 'supplierId', 'vehicleId']),
  });
}

add({
  id: 'DOCTYPE-052',
  documentType: 'hr',
  subtype: 'bewerbung',
  label: 'Bewerbung',
  groupId: 'DOCGROUP-024',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'optional',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'forbidden',
    unassigned: 'allowed',
  },
  fields: F([], ['employeeId'], ['projectId', 'customerId', 'supplierId', 'vehicleId']),
  notes: 'Vor Einstellung oft ohne employeeId.',
});

add({
  id: 'DOCTYPE-054',
  documentType: 'hr',
  subtype: 'krankmeldung',
  label: 'Krankmeldung',
  groupId: 'DOCGROUP-024',
  defaultLifecyclePhase: 'firm',
  relations: {
    ...R.hrEmployee,
    counterparty: 'optional',
  },
  fields: F(['employeeId'], ['supplierId'], ['projectId', 'customerId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-056',
  documentType: 'hr',
  subtype: 'lohnabrechnung',
  label: 'Lohnabrechnung',
  groupId: 'DOCGROUP-024',
  defaultLifecyclePhase: 'firm',
  relations: {
    ...R.hrEmployee,
    counterparty: 'optional',
  },
  fields: F(['employeeId'], ['supplierId'], ['projectId', 'customerId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-057',
  documentType: 'hr',
  subtype: 'stundennachweis',
  label: 'Stundennachweis',
  groupId: 'DOCGROUP-024',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'required',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  fields: F(['employeeId'], ['projectId'], ['customerId', 'supplierId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-059',
  documentType: 'marketing',
  subtype: 'kampagne',
  label: 'Marketing Kampagne',
  groupId: 'DOCGROUP-025',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'optional',
    unassigned: 'allowed',
  },
  fields: F([], ['supplierId'], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-060',
  documentType: 'marketing',
  subtype: 'werbung',
  label: 'Werbung',
  groupId: 'DOCGROUP-026',
  defaultLifecyclePhase: 'firm',
  relations: R.unassignedOnly,
  fields: F([], [], ['projectId', 'customerId', 'supplierId', 'employeeId', 'vehicleId']),
  notes: 'Bewusst ohne fachliche Zuordnung.',
});

add({
  id: 'DOCTYPE-061',
  documentType: 'spam',
  subtype: 'spam',
  label: 'Spam',
  groupId: 'DOCGROUP-027',
  defaultLifecyclePhase: 'firm',
  relations: R.unassignedOnly,
  fields: F([], [], ['projectId', 'customerId', 'supplierId', 'employeeId', 'vehicleId']),
  notes: 'Negativbeispiel Matching / Inbox.',
});

add({
  id: 'DOCTYPE-062',
  documentType: 'legal_letter',
  subtype: 'gericht',
  label: 'Gericht',
  groupId: 'DOCGROUP-029',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId', 'customerId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-063',
  documentType: 'legal_letter',
  subtype: 'inkasso_eingehend',
  label: 'Inkasso eingehend',
  groupId: 'DOCGROUP-030',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId'], ['customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-064',
  documentType: 'legal_letter',
  subtype: 'inkasso_ausgehend',
  label: 'Inkasso ausgehend',
  groupId: 'DOCGROUP-030',
  defaultLifecyclePhase: 'billing',
  relations: {
    project: 'typical',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'required',
    counterparty: 'typical',
    unassigned: 'forbidden',
  },
  fields: F(['customerId'], ['projectId', 'supplierId'], ['employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-065',
  documentType: 'legal_letter',
  subtype: 'datenschutz',
  label: 'Datenschutz',
  groupId: 'DOCGROUP-031',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'forbidden',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'optional',
    unassigned: 'allowed',
  },
  fields: F([], ['supplierId'], ['projectId', 'customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-066',
  documentType: 'payment_reminder',
  subtype: 'zahlungserinnerung_kunde',
  label: 'Zahlungserinnerung an Kunde',
  groupId: 'DOCGROUP-007',
  defaultLifecyclePhase: 'billing',
  relations: R.typicalProjectCustomer,
  fields: F(['customerId'], ['projectId'], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-067',
  documentType: 'dunning',
  subtype: 'mahnung_kunde',
  label: 'Mahnung an Kunde',
  groupId: 'DOCGROUP-007',
  defaultLifecyclePhase: 'billing',
  relations: R.typicalProjectCustomer,
  fields: F(['customerId'], ['projectId'], ['supplierId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-068',
  documentType: 'dunning',
  subtype: 'mahnung_lieferant',
  label: 'Mahnung vom Lieferanten',
  groupId: 'DOCGROUP-006',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'forbidden',
    vehicle: 'forbidden',
    customer: 'forbidden',
    counterparty: 'required',
    unassigned: 'forbidden',
  },
  fields: F(['supplierId'], ['projectId'], ['customerId', 'employeeId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-069',
  documentType: 'acceptance',
  subtype: 'abnahmeprotokoll',
  label: 'Abnahmeprotokoll',
  groupId: 'DOCGROUP-028',
  defaultLifecyclePhase: 'billing',
  relations: {
    project: 'required',
    company: 'required',
    employee: 'optional',
    vehicle: 'forbidden',
    customer: 'required',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  fields: F(['projectId', 'customerId'], ['employeeId'], ['supplierId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-070',
  documentType: 'inspection_protocol',
  subtype: 'aufmass',
  label: 'Aufmaßprotokoll',
  groupId: 'DOCGROUP-028',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'required',
    company: 'required',
    employee: 'optional',
    vehicle: 'forbidden',
    customer: 'typical',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  fields: F(['projectId'], ['customerId', 'employeeId'], ['supplierId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-071',
  documentType: 'site_diary',
  subtype: 'bautagebuch',
  label: 'Bautagebuch',
  groupId: 'DOCGROUP-028',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'required',
    company: 'required',
    employee: 'optional',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  fields: F(['projectId'], ['customerId', 'employeeId'], ['supplierId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-072',
  documentType: 'photo',
  subtype: 'baustellenfoto',
  label: 'Baustellenfoto',
  groupId: 'DOCGROUP-028',
  defaultLifecyclePhase: 'execution',
  relations: {
    project: 'required',
    company: 'required',
    employee: 'optional',
    vehicle: 'forbidden',
    customer: 'optional',
    counterparty: 'forbidden',
    unassigned: 'forbidden',
  },
  fields: F(['projectId'], ['customerId', 'employeeId'], ['supplierId', 'vehicleId']),
});

add({
  id: 'DOCTYPE-073',
  documentType: 'other',
  subtype: 'unklar',
  label: 'Unklar / Sonstige',
  groupId: 'DOCGROUP-028',
  defaultLifecyclePhase: 'firm',
  relations: {
    project: 'optional',
    company: 'required',
    employee: 'optional',
    vehicle: 'optional',
    customer: 'optional',
    counterparty: 'optional',
    unassigned: 'allowed',
  },
  fields: F([], ['projectId', 'customerId', 'supplierId', 'employeeId', 'vehicleId'], []),
  notes: 'Restklasse; Quality-Tags steuern Erwartung.',
});

add({
  id: 'DOCTYPE-074',
  documentType: 'marketing',
  subtype: 'newsletter',
  label: 'Newsletter',
  groupId: 'DOCGROUP-025',
  defaultLifecyclePhase: 'firm',
  relations: R.unassignedOnly,
  fields: F([], [], ['projectId', 'customerId', 'supplierId', 'employeeId', 'vehicleId']),
  notes: '02B extend: Newsletter bewusst ohne fachliche Zuordnung.',
});

const taxonomy = {
  version: '2A.1',
  status: 'frozen',
  frozenAt: '2026-08-01',
  policy: {
    rename: 'forbidden',
    remove: 'forbidden',
    extend: 'allowed',
    notes:
      'Nach TESTWORLD-IMPLEMENTATION-02A: groupId/key, documentType, subtype, DOCTYPE-IDs sind immutable. Neue Gruppen/Typen nur am Ende anfügen.',
  },
  groups: groups.map(([id, key, label, description]) => ({ id, key, label, description })),
  documentTypes: documentTypes.map(([key, label, description]) => ({ key, label, description })),
  types,
};

mkdirSync(join(root, 'taxonomy'), { recursive: true });
const out = join(root, 'taxonomy', 'document-taxonomy.json');
writeFileSync(out, `${JSON.stringify(taxonomy, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${out}: groups=${taxonomy.groups.length} documentTypes=${taxonomy.documentTypes.length} types=${taxonomy.types.length}`,
);
