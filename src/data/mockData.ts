import type {
  CompanySetup,
  OrderPosition,
  PaperFolder,
  Vorgang,
} from '../types/models';

export const DEFAULT_SETUP: CompanySetup = {
  companyName: '',
  industry: '',
  taxStatus: 'standard_19',
  materialStandard: 'betrieb',
  language: 'de',
  setupComplete: false,
  setupVersion: 0,
  communicationChannel: 'email',
};

export const PAPER_FOLDERS: PaperFolder[] = [
  {
    id: 'folder-1',
    name: 'Eingangsrechnungen 2026',
    year: 2026,
    registers: ['A', 'B', 'C', 'D'],
  },
  {
    id: 'folder-2',
    name: 'Kundenaufträge 2026',
    year: 2026,
    registers: ['A', 'B', 'C'],
  },
  {
    id: 'folder-3',
    name: 'Ausgangsrechnungen 2026',
    year: 2026,
    registers: ['A', 'B'],
  },
  {
    id: 'folder-4',
    name: 'Steuerberater 2026',
    year: 2026,
    registers: ['Monat 01', 'Monat 02', 'Monat 03'],
  },
  {
    id: 'folder-5',
    name: 'Behörden & Versicherungen',
    registers: ['A', 'B', 'C'],
  },
];

export const MOCK_ORDER_POSITIONS_V001: OrderPosition[] = [
  {
    id: 'op-001',
    description: 'Trockenbauwand stellen',
    plannedQuantity: 120,
    unit: 'm²',
    unitPrice: 42,
    category: 'arbeit',
  },
  {
    id: 'op-002',
    description: 'Decke spachteln',
    plannedQuantity: 80,
    unit: 'm²',
    unitPrice: 28,
    category: 'arbeit',
  },
  {
    id: 'op-003',
    description: 'Türen einbauen',
    plannedQuantity: 6,
    unit: 'Stück',
    unitPrice: 185,
    category: 'arbeit',
  },
  {
    id: 'op-004',
    description: 'Arbeitsstunden Zusatzarbeit',
    plannedQuantity: 20,
    unit: 'Stunden',
    unitPrice: 68,
    category: 'arbeit',
  },
  {
    id: 'op-005',
    description: 'Sanitär-Material (Fliesen, Armaturen)',
    plannedQuantity: 1,
    unit: 'Pauschal',
    unitPrice: 2400,
    category: 'material',
    billable: false,
  },
];

export const MOCK_VORGAENGE: Vorgang[] = [
  {
    id: 'v-001',
    title: 'Badezimmer-Sanierung Müller',
    customer: 'Familie Müller',
    baustelle: 'Hauptstr. 12, Berlin',
    status: 'in_bearbeitung',
    materialSource: 'auftraggeber',
    orderPositions: MOCK_ORDER_POSITIONS_V001.map((p) => ({ ...p })),
    documents: [
      {
        id: 'd-001',
        name: 'Kundenauftrag Müller.pdf',
        type: 'kundenauftrag',
        date: '2026-03-10',
        paperFiling: {
          folderId: 'folder-2',
          register: 'A',
          label: 'Kundenaufträge 2026',
        },
      },
      {
        id: 'd-002',
        name: 'Materialrechnung Sanitär GmbH.pdf',
        type: 'eingangsrechnung',
        date: '2026-03-15',
        paperFiling: {
          folderId: 'folder-1',
          register: 'B',
          label: 'Eingangsrechnungen 2026',
        },
      },
    ],
    tasks: [
      {
        id: 'vt-001',
        type: 'rechnung_vorbereiten',
        title: 'Schlussrechnung vorbereiten',
        done: false,
        dueDate: '2026-04-01',
      },
      {
        id: 'vt-002',
        type: 'dokument_pruefen',
        title: 'Materialrechnung prüfen',
        done: true,
      },
    ],
    photos: [
      {
        id: 'p-001',
        caption: 'Fliesenarbeiten Fortschritt',
        date: '2026-03-18',
      },
      {
        id: 'p-002',
        caption: 'Sanitärinstallation',
        date: '2026-03-20',
      },
    ],
    invoices: [],
  },
  {
    id: 'v-002',
    title: 'Elektroinstallation Weber',
    customer: 'Weber GmbH',
    baustelle: 'Industriestr. 45, Potsdam',
    status: 'neu',
    materialSource: 'betrieb',
    orderPositions: [],
    documents: [
      {
        id: 'd-003',
        name: 'Auftragsbestätigung Weber.pdf',
        type: 'kundenauftrag',
        date: '2026-03-25',
        paperFiling: {
          folderId: 'folder-2',
          register: 'B',
          label: 'Kundenaufträge 2026',
        },
      },
    ],
    tasks: [
      {
        id: 'vt-003',
        type: 'brief_abheften',
        title: 'Auftragsbestätigung abheften',
        done: false,
      },
    ],
    photos: [],
    invoices: [],
  },
  {
    id: 'v-003',
    title: 'Dachreparatur Schmidt',
    customer: 'Schmidt & Söhne',
    baustelle: 'Gartenweg 7, Brandenburg',
    status: 'wartet',
    materialSource: 'gemischt',
    orderPositions: [],
    documents: [],
    tasks: [
      {
        id: 'vt-004',
        type: 'kontoauszug_hochladen',
        title: 'Kontoauszug März hochladen',
        done: false,
        dueDate: '2026-03-31',
      },
    ],
    photos: [
      {
        id: 'p-003',
        caption: 'Schadensstelle Dach',
        date: '2026-03-12',
      },
    ],
    invoices: [],
  },
];

export const MOCK_TASKS = [
  {
    id: 't-001',
    type: 'dokument_pruefen',
    title: 'Dokument prüfen',
    description: 'Materialrechnung Sanitär GmbH – Vorgang Müller',
    vorgangId: 'v-001',
    vorgangTitle: 'Badezimmer-Sanierung Müller',
    done: false,
    dueDate: '2026-03-28',
  },
  {
    id: 't-002',
    type: 'brief_abheften',
    title: 'Brief abheften',
    description: 'Auftragsbestätigung Weber – Ordner 2, Register B',
    vorgangId: 'v-002',
    vorgangTitle: 'Elektroinstallation Weber',
    done: false,
  },
  {
    id: 't-003',
    type: 'rechnung_vorbereiten',
    title: 'Rechnung vorbereiten',
    description: 'Schlussrechnung für Badezimmer-Sanierung Müller',
    vorgangId: 'v-001',
    vorgangTitle: 'Badezimmer-Sanierung Müller',
    done: false,
    dueDate: '2026-04-01',
  },
  {
    id: 't-004',
    type: 'kontoauszug_hochladen',
    title: 'Kontoauszug hochladen',
    description: 'Kontoauszug März 2026 für Steuerberater',
    done: false,
    dueDate: '2026-03-31',
  },
  {
    id: 't-005',
    type: 'steuerberater_export',
    title: 'Steuerberater Export vorbereiten',
    description: 'Belege Q1 2026 zusammenstellen',
    done: false,
    dueDate: '2026-04-05',
  },
];

export const INDUSTRY_OPTIONS = [
  'Handwerk – Sanitär/Heizung',
  'Handwerk – Elektro',
  'Handwerk – Maler',
  'Handwerk – Dachdecker',
  'Handwerk – Allgemein',
  'Dienstleistung',
  'Einzelhandel',
  'Sonstiges',
];
