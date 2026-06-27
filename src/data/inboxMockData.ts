import type { InboxItem } from '../types/models';

export const MOCK_INBOX_ITEMS: InboxItem[] = [
  {
    id: 'inbox-001',
    title: 'Neuer Auftrag Müller',
    documentType: 'kundenauftrag',
    sender: 'Familie Müller',
    priority: 'hoch',
    deadline: '2026-04-02',
    recommendedAction: 'auftrag_annehmen',
    digitalFolder: {
      id: 'dig-inbox-001',
      name: 'Kundenaufträge',
      path: '/Vorgänge/Neu/Müller-Auftrag/',
    },
    paperFiling: {
      folderId: 'folder-2',
      register: 'C',
      label: 'Kundenaufträge 2026',
    },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: {
      Kunde: 'Familie Müller',
      Baustelle: 'Hauptstr. 12, Berlin',
      Leistung: 'Badezimmer-Komplettsanierung',
      Angebotssumme: 'ca. 8.500 €',
      'Gewünschter Start': 'KW 15 / 2026',
    },
    officePilotSuggestion:
      'Neuer Kundenauftrag erkannt. Prüfen Sie Umfang und Termine, dann annehmen oder Rückfrage an den Kunden stellen.',
    nextTaskLabel: 'Auftrag Müller annehmen oder Rückfrage stellen',
    securityHint:
      'OfficePilot nimmt keine Aufträge automatisch an und versendet keine Antworten ohne Ihre Bestätigung.',
    taskTemplate: {
      type: 'dokument_pruefen',
      title: 'Auftrag Müller annehmen oder Rückfrage stellen',
      description: 'Kundenauftrag von Familie Müller prüfen und Entscheidung treffen',
      dueDate: '2026-04-02',
    },
  },
  {
    id: 'inbox-002',
    title: 'Zahlungserinnerung Bauzentrum',
    documentType: 'eingangsrechnung',
    sender: 'Bauzentrum Nord GmbH',
    priority: 'kritisch',
    deadline: '2026-03-30',
    recommendedAction: 'zahlung_pruefen',
    digitalFolder: {
      id: 'dig-inbox-002',
      name: 'Eingangsrechnungen',
      path: '/Eingang/Rechnungen/Bauzentrum/',
    },
    paperFiling: {
      folderId: 'folder-1',
      register: 'D',
      label: 'Eingangsrechnungen 2026',
    },
    status: 'neu',
    receivedAt: '2026-03-26',
    recognizedData: {
      Rechnungsnummer: 'BZ-2026-8842',
      Betrag: '1.247,80 €',
      Fälligkeit: '30.03.2026',
      Referenz: 'Material Lieferung KW 11',
    },
    officePilotSuggestion:
      'Zahlungserinnerung erkannt. Bitte prüfen, ob diese Rechnung bereits bezahlt wurde, bevor Sie reagieren.',
    nextTaskLabel: 'Zahlung prüfen',
    securityHint:
      'Bitte prüfen, ob diese Rechnung bereits bezahlt wurde. OfficePilot löst keine Zahlung automatisch aus.',
    taskTemplate: {
      type: 'dokument_pruefen',
      title: 'Zahlung prüfen',
      description: 'Zahlungserinnerung Bauzentrum Nord – Zahlungsstatus prüfen',
      dueDate: '2026-03-30',
    },
  },
  {
    id: 'inbox-003',
    title: 'Hornbach Materialrechnung',
    documentType: 'eingangsrechnung',
    sender: 'Hornbach Baumarkt AG',
    priority: 'mittel',
    deadline: '2026-04-15',
    recommendedAction: 'zuordnen',
    digitalFolder: {
      id: 'dig-inbox-003',
      name: 'Eingangsrechnungen',
      path: '/Vorgänge/Müller/Material/Hornbach/',
    },
    paperFiling: {
      folderId: 'folder-1',
      register: 'C',
      label: 'Eingangsrechnungen 2026',
    },
    status: 'neu',
    receivedAt: '2026-03-25',
    vorgangId: 'v-001',
    vorgangTitle: 'Badezimmer-Sanierung Müller',
    recognizedData: {
      Rechnungsnummer: 'HB-9928471',
      Betrag: '342,16 €',
      Artikel: 'Fliesenkleber, Fugenmasse, Dichtband',
      Vorgang: 'Badezimmer-Sanierung Müller',
    },
    officePilotSuggestion:
      'Materialrechnung erkannt und Vorgang Müller vorgeschlagen. Bitte Betrag und Zuordnung prüfen.',
    nextTaskLabel: 'Rechnung Vorgang zuordnen und abheften',
    securityHint:
      'OfficePilot ändert keine Beträge und ordnet nichts endgültig zu ohne Ihre Bestätigung.',
    taskTemplate: {
      type: 'dokument_pruefen',
      title: 'Materialrechnung Hornbach prüfen',
      description: 'Hornbach-Rechnung dem Vorgang Müller zuordnen',
      vorgangId: 'v-001',
      vorgangTitle: 'Badezimmer-Sanierung Müller',
    },
  },
  {
    id: 'inbox-004',
    title: 'BG BAU Schreiben',
    documentType: 'behoerde',
    sender: 'BG BAU – Berufsgenossenschaft',
    priority: 'hoch',
    deadline: '2026-04-10',
    recommendedAction: 'abheften',
    digitalFolder: {
      id: 'dig-inbox-004',
      name: 'Behörden & Versicherungen',
      path: '/Behörden/BG-BAU/2026/',
    },
    paperFiling: {
      folderId: 'folder-5',
      register: 'A',
      label: 'Behörden & Versicherungen',
    },
    status: 'neu',
    receivedAt: '2026-03-24',
    recognizedData: {
      Aktenzeichen: 'BG-BAU-2026-4412',
      Betreff: 'Beitragsbescheid Q1 2026',
      Frist: '10.04.2026',
      Betrag: '1.890,00 €',
    },
    officePilotSuggestion:
      'Behördenschreiben mit Frist erkannt. Bitte Inhalt prüfen und Original abheften.',
    nextTaskLabel: 'BG BAU Schreiben prüfen',
    securityHint:
      'OfficePilot gibt keine Steuer- oder Rechtsberatung. Bei Unsicherheit bitte Steuerberater oder Fachanwalt konsultieren.',
    taskTemplate: {
      type: 'dokument_pruefen',
      title: 'BG BAU Schreiben prüfen',
      description: 'Beitragsbescheid BG BAU Q1 2026 prüfen und Frist beachten',
      dueDate: '2026-04-10',
    },
  },
  {
    id: 'inbox-005',
    title: 'Werbung / Reklame',
    documentType: 'sonstiges',
    sender: 'Baumarkt Aktionsmail',
    priority: 'niedrig',
    deadline: null,
    recommendedAction: 'entsorgen',
    digitalFolder: {
      id: 'dig-inbox-005',
      name: 'Werbung',
      path: '/Eingang/Werbung/',
    },
    paperFiling: {
      folderId: 'folder-5',
      register: '–',
      label: 'Nicht abheften – Werbung',
    },
    status: 'neu',
    receivedAt: '2026-03-27',
    isAdvertisement: true,
    recognizedData: {
      Absender: 'Baumarkt Aktionsmail',
      Inhalt: 'Sommer-Sale Prospekt',
      Kategorie: 'Werbung / Reklame',
    },
    officePilotSuggestion:
      'Werbung erkannt – keine geschäftliche Relevanz. Entsorgen oder bei Bedarf manuell speichern.',
    nextTaskLabel: 'Keine Aufgabe nötig',
    securityHint:
      'OfficePilot löscht nichts automatisch. Entsorgung erfolgt nur nach Ihrer ausdrücklichen Bestätigung.',
  },
  {
    id: 'inbox-006',
    title: 'Kontoauszug Juni',
    documentType: 'sonstiges',
    sender: 'Sparkasse Berlin',
    priority: 'mittel',
    deadline: '2026-07-05',
    recommendedAction: 'steuerberater_vorbereiten',
    digitalFolder: {
      id: 'dig-inbox-006',
      name: 'Steuerberater',
      path: '/Steuerberater/2026/Kontoauszüge/',
    },
    paperFiling: {
      folderId: 'folder-4',
      register: 'Monat 06',
      label: 'Steuerberater 2026',
    },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: {
      Konto: 'Geschäftskonto · DE89 **** 4521',
      Zeitraum: '01.06.2026 – 30.06.2026',
      Seiten: '4',
    },
    officePilotSuggestion:
      'Kontoauszug erkannt. Für den Steuerberater vorbereiten und Original abheften.',
    nextTaskLabel: 'Kontoauszug an Steuerberater vorbereiten',
    securityHint:
      'OfficePilot leitet keine Bankdaten weiter und versendet nichts automatisch an den Steuerberater.',
    taskTemplate: {
      type: 'steuerberater_export',
      title: 'Kontoauszug an Steuerberater vorbereiten',
      description: 'Kontoauszug Juni 2026 für Steuerberater-Export vorbereiten',
      dueDate: '2026-07-05',
    },
  },
];
