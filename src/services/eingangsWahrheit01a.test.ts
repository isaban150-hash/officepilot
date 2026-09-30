/**
 * EINGANG-01A — Eingangs-Wahrheit / Datenintegrität.
 *
 * Je Befund eine positive und eine negative Kontrolle:
 *  P0-1  keine Beispielwerte in recognizedData oder in echten Ausgaben
 *  P0-2  eine kanonische Handlungsfrist (JJJJ-MM-TT); Gültigkeit ≠ Frist
 *  P1-1  Vorgang nur eindeutig oder ausdrücklich gewählt
 *  P1-2  dieselbe vorgeschlagene Aufgabe nur einmal
 *  P1-3  „Werbungskosten" ist keine Werbung
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setOcrOnlyRecognizedDataEnabledForTests } from '../config/documentIntelligenceConfig';
import { createTestVorgang } from '../test/fixtures';
import { toCanonicalIsoDay } from '../utils/documentDateDisplay';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { classifyDocument, classifyInboxItem } from './documentClassificationService';
import { hydrateDocumentStore, mapInboxItemToDocumentInput } from './documentService';
import { getAllExpenses } from './expenseService';
import { setExpenseStoreForTests } from './expenseStore';
import { hydrateInboxStore, updateInboxItemRecognizedData } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import { createExpenseFromInbox } from './officeActionService';
import { listDueTasks, scanAuthorityDeadlines } from './pendingEngineService';
import { createTaskFromProposal } from './taskEngineService';
import { normalizeTask } from './taskNormalize';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import type { ClassifiedDocumentKind, InboxItem, TaskProposal } from '../types/models';

const PROFILE = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

/** Die früheren Beispielwerte der Erkennung. Keiner davon darf ohne Beleg auftauchen. */
const SAMPLE_VALUES = [
  'RE-2026-0001',
  '342,16 €',
  '85,40 €',
  'ca. 5.000 €',
  'Sanierungsarbeiten',
  'Baustelle laut Auftrag',
  'Geschäftskonto',
  'Interessent',
  'Mitarbeiter',
  'Unbekannt',
];

function inbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-01a',
    title: 'Eingangsrechnung Baustoff Meyer',
    documentType: 'eingangsrechnung',
    classifiedKind: 'eingangsrechnung',
    sender: 'Baustoff Meyer GmbH',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'zuordnen',
    digitalFolder: { id: 'd', name: 'n', path: '/' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: '2026-09-28',
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  hydrateCompanyProfileStore(PROFILE);
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  setTaskStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateVorgangStore([]);
});

afterEach(() => {
  setOcrOnlyRecognizedDataEnabledForTests(null);
});

describe('P0-1 — keine Beispielwerte', () => {
  const kinds: ClassifiedDocumentKind[] = [
    'eingangsrechnung',
    'rechnung',
    'auftrag',
    'kontoauszug',
    'angebot',
    'lieferschein',
    'stundenzettel',
    'tankbeleg',
    'abnahmeprotokoll',
  ];

  it('negativ: keine Dokumentart erhält ohne Textbeleg einen Beispielwert — auch im Rückfallweg', () => {
    for (const ocrOnly of [true, false]) {
      setOcrOnlyRecognizedDataEnabledForTests(ocrOnly);
      for (const kind of kinds) {
        const result = classifyDocument({
          kindHint: kind,
          titleHint: 'Scan 17',
          recognizedText: 'Dokument ohne erkennbare Details',
        });
        const values = Object.values(result.recognizedData);
        for (const sample of SAMPLE_VALUES) {
          expect(values, `${kind} (ocrOnly=${ocrOnly}) enthält ${sample}`).not.toContain(sample);
        }
        // Der Dateititel ist kein Beleg für einen Vorgang.
        expect(result.recognizedData.Vorgang, `${kind}: Vorgang aus Titel`).toBeUndefined();
      }
    }
  });

  it('positiv: echte Werte aus dem Text bleiben erhalten — auch im Rückfallweg', () => {
    for (const ocrOnly of [true, false]) {
      setOcrOnlyRecognizedDataEnabledForTests(ocrOnly);
      const result = classifyDocument({
        kindHint: 'eingangsrechnung',
        senderHint: 'Baustoff Meyer GmbH',
        // „Betrag:" — der Rückfallweg liest „Gesamtbetrag: … €" nicht (bestehende Grenze).
        recognizedText: 'Rechnung\nRechnungsnummer: MR-2026-118\nBetrag: 486,20 EUR',
      });
      expect(result.recognizedData.Rechnungsnummer).toBe('MR-2026-118');
      expect(result.recognizedData.Betrag).toContain('486,20');
    }
  });

  it('negativ: ein älterer Eingang mit Beispielbetrag wird nicht still gebucht — Formularweg', () => {
    const item = inbox({ recognizedData: { Betrag: '342,16 €', Rechnungsnummer: 'RE-2026-0001' } });
    hydrateInboxStore([item]);
    const result = createExpenseFromInbox(item);
    expect(result).toMatchObject({ ok: true, kind: 'navigate', route: `/ausgaben/neu?inboxId=${item.id}` });
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('negativ: ein Betrag, der im vorhandenen Dokumenttext nicht steht, wird nicht still gebucht', () => {
    const item = inbox({
      recognizedData: {
        Betrag: '999,00 €',
        Rechnungsnummer: 'MR-7',
        _extractedText: 'Rechnung\nRechnungsnummer: MR-7\nGesamtbetrag: 486,20 EUR',
      },
    });
    hydrateInboxStore([item]);
    const result = createExpenseFromInbox(item);
    expect(result).toMatchObject({ kind: 'navigate', route: `/ausgaben/neu?inboxId=${item.id}` });
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('positiv: eine vollständige Rechnung mit belegtem Betrag wird weiterhin angelegt', () => {
    const item = inbox({
      recognizedData: {
        Betrag: '1.486,20 €',
        Rechnungsnummer: 'MR-8',
        _extractedText: 'Rechnung\nRechnungsnummer: MR-8\nGesamtbetrag: 1.486,20 EUR',
      },
    });
    hydrateInboxStore([item]);
    const result = createExpenseFromInbox(item);
    expect(result.ok).toBe(true);
    const expenses = getAllExpenses();
    expect(expenses).toHaveLength(1);
    expect(expenses[0].grossAmount).toBe(1486.2);
    expect(expenses[0].invoiceNumber).toBe('MR-8');
  });
});

describe('P0-2 — eine kanonische Handlungsfrist', () => {
  it('toCanonicalIsoDay: ISO und TT.MM.JJJJ werden zum Tag, Unlesbares ist keine Frist', () => {
    expect(toCanonicalIsoDay('2026-10-15')).toBe('2026-10-15');
    expect(toCanonicalIsoDay('2026-10-15T23:30:00Z')).toBe('2026-10-15');
    expect(toCanonicalIsoDay('15.10.2026')).toBe('2026-10-15');
    expect(toCanonicalIsoDay('5.1.2027')).toBe('2027-01-05');
    expect(toCanonicalIsoDay('31.02.2026')).toBeNull();
    expect(toCanonicalIsoDay('2026-02-31')).toBeNull();
    expect(toCanonicalIsoDay('15/10/26')).toBeNull();
    expect(toCanonicalIsoDay('demnächst')).toBeNull();
    expect(toCanonicalIsoDay('')).toBeNull();
    expect(toCanonicalIsoDay(null)).toBeNull();
  });

  it('positiv: Zahlungsfrist im Text → Eingangsfrist als ISO', () => {
    const result = classifyDocument({
      kindHint: 'eingangsrechnung',
      recognizedText:
        'Rechnung\nAn: Mustermann Sanitär GmbH\nRechnungsnummer: R-1\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026',
    });
    expect(result.deadline).toBe('2026-10-15');
    const item = classifyInboxItem({ kindHint: 'mahnung', recognizedText: 'Mahnung\nBetrag: 1.247,80 EUR\nFälligkeit: 30.03.2026' });
    expect(item.deadline).toBe('2026-03-30');
  });

  it('negativ: ein Gültigkeitsende ist keine Handlungsfrist — beide Erkennungswege', () => {
    for (const ocrOnly of [true, false]) {
      setOcrOnlyRecognizedDataEnabledForTests(ocrOnly);
      const offer = classifyDocument({
        kindHint: 'angebot',
        recognizedText: 'Angebot Nr. 5\nDieses Angebot ist gültig bis 30.11.2026',
      });
      expect(offer.deadline, `ocrOnly=${ocrOnly}`).toBeNull();
      expect(offer.recognizedData.Frist).toBeUndefined();
      // Der Feld-Rückfallweg hält das Gültigkeitsende getrennt fest.
      if (!ocrOnly) expect(offer.recognizedData.Gültig_bis).toBe('30.11.2026');
    }
  });

  it('Gültigkeit im Archiv nur aus dem Gültigkeitsende, nie aus der Handlungsfrist', () => {
    const payable = mapInboxItemToDocumentInput(inbox({ deadline: '2026-10-15' }), 'Mustermann Sanitär GmbH');
    expect(payable.validUntil).toBeNull();
    const certificate = mapInboxItemToDocumentInput(
      inbox({ deadline: null, recognizedData: { Gültig_bis: '31.08.2029' } }),
      'Mustermann Sanitär GmbH',
    );
    expect(certificate.validUntil).toBe('2029-08-31');
    // Älterer Eingang ohne Feld: das Gültigkeitsende aus dem gespeicherten Text, nicht die Frist.
    const legacy = mapInboxItemToDocumentInput(
      inbox({
        deadline: '2026-10-15',
        recognizedData: { _extractedText: 'Freistellungsbescheinigung nach § 48b EStG\nGültig bis 31.12.2026' },
      }),
      'Mustermann Sanitär GmbH',
    );
    expect(legacy.validUntil).toBe('2026-12-31');
  });

  it('ältere TT.MM.JJJJ-Fristen werden richtig verglichen, nicht als Text', () => {
    const base = { title: 'Mustermann Sanitär GmbH', recognizedData: { Betreff: 'Mustermann Sanitär GmbH' } };
    hydrateInboxStore([
      inbox({ ...base, id: 'fa-future', classifiedKind: 'finanzamt', documentType: 'behoerde', deadline: '15.12.2026' }),
      inbox({ ...base, id: 'fa-past', classifiedKind: 'finanzamt', documentType: 'behoerde', deadline: '15.09.2026' }),
      inbox({ ...base, id: 'fa-garbage', classifiedKind: 'finanzamt', documentType: 'behoerde', deadline: 'demnächst' }),
    ]);
    const ids = scanAuthorityDeadlines('2026-10-01').map((entry) => entry.sourceId);
    expect(ids).toContain('fa-past');
    expect(ids).not.toContain('fa-future');
    expect(ids).not.toContain('fa-garbage');
  });

  it('Aufgaben: ältere Fälligkeit wird zum Tag gelesen; Zukunft ist nicht überfällig', () => {
    setTaskStoreForTests([
      normalizeTask({ id: 't-future', title: 'Zukunft', dueDate: '15.12.2026' }),
      normalizeTask({ id: 't-past', title: 'Vergangen', dueDate: '15.09.2026' }),
    ]);
    expect(getAllTasksFromStore().find((t) => t.id === 't-future')?.dueDate).toBe('2026-12-15');
    const due = listDueTasks('2026-10-01');
    expect(due.overdue.map((t) => t.id)).toEqual(['t-past']);
  });

  it('Bearbeiten: eine Frist wird als Tag gespeichert, Unlesbares nicht', () => {
    hydrateInboxStore([inbox({ id: 'edit-1' })]);
    expect(updateInboxItemRecognizedData('edit-1', { deadline: '2026-11-02' })?.deadline).toBe('2026-11-02');
    expect(updateInboxItemRecognizedData('edit-1', { deadline: '02.11.2026' })?.deadline).toBe('2026-11-02');
    expect(updateInboxItemRecognizedData('edit-1', { deadline: 'irgendwann' })?.deadline).toBeNull();
  });
});

describe('P1-1 — Vorgang nur eindeutig oder ausdrücklich', () => {
  beforeEach(() => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-mueller',
        title: 'Badezimmer-Sanierung Müller',
        customer: 'Familie Müller',
        baustelle: 'Hauptstr. 12, Berlin',
        status: 'in_bearbeitung',
      }),
    ]);
  });

  it('negativ: bloße Ähnlichkeit (Absender = Kunde eines Vorgangs) verknüpft nicht und wird nicht zur Übernahme vorgeschlagen', () => {
    // Kein Fallabgleich-Treffer (`none`), aber die frühere Ähnlichkeitssuche schlug v-mueller („medium") vor.
    const item = inbox({
      id: 'inbox-fuzzy',
      title: 'Lieferschein',
      classifiedKind: 'lieferschein',
      documentType: 'lieferschein',
      sender: 'Familie Müller',
      recognizedData: { Betreff: 'Mustermann Sanitär GmbH' },
    });
    hydrateInboxStore([item]);
    const result = processUploadedDocument(item.id);
    expect(result).not.toBeNull();
    expect(result!.suggestedVorgang).toBeNull();
    expect(result!.nextActions.some((action) => action.id === 'link_vorgang')).toBe(false);
    // Der ähnliche Vorgang bleibt zur ausdrücklichen Auswahl sichtbar.
    expect(result!.similarVorgaenge.map((v) => v.id)).toContain('v-mueller');
  });

  it('positiv: der ausdrücklich gewählte Vorgang bleibt der Vorschlag', () => {
    const item = inbox({
      id: 'inbox-explicit',
      title: 'Lieferschein',
      classifiedKind: 'lieferschein',
      documentType: 'lieferschein',
      vorgangId: 'v-mueller',
      vorgangTitle: 'Badezimmer-Sanierung Müller',
      recognizedData: { Betreff: 'Mustermann Sanitär GmbH' },
    });
    hydrateInboxStore([item]);
    const result = processUploadedDocument(item.id);
    expect(result!.suggestedVorgang?.vorgangId).toBe('v-mueller');
    expect(result!.nextActions.some((action) => action.id === 'link_vorgang' && action.enabled)).toBe(true);
  });

  it('negativ: die Klassifikation schreibt keinen vermuteten Vorgangstitel in recognizedData', () => {
    const result = classifyDocument({
      kindHint: 'eingangsrechnung',
      senderHint: 'Familie Müller',
      titleHint: 'Badezimmer-Sanierung Müller',
      recognizedText: 'Rechnung\nKunde: Familie Müller\nRechnungsnummer: R-55\nGesamtbetrag 119,00 EUR',
    });
    expect(result.recognizedData.Vorgang).toBeUndefined();
  });
});

describe('P1-2 — dieselbe Aufgabe nur einmal', () => {
  function proposal(overrides: Partial<TaskProposal>): TaskProposal {
    return {
      title: 'Zahlung prüfen',
      description: 'offenen Betrag prüfen',
      priority: 'kritisch',
      category: 'zahlungen',
      sourceType: 'classification',
      sourceId: 'inbox-dup',
      taskKind: 'payment_check',
      linkedInboxId: 'inbox-dup',
      autoCreated: false,
      type: 'dokument_pruefen',
      ...overrides,
    };
  }

  it('negativ: gleiche Quelle + gleiches Objekt + gleiche Art unter zwei Schlüsseln → eine Aufgabe', () => {
    const first = createTaskFromProposal(proposal({}));
    const second = createTaskFromProposal(proposal({ dedupeKey: 'inbox:inbox-dup:follow_up' }));
    expect(second.id).toBe(first.id);
    expect(getAllTasksFromStore()).toHaveLength(1);
  });

  it('positiv: verschiedene Aufgaben desselben Dokuments bleiben getrennt', () => {
    createTaskFromProposal(proposal({ taskKind: 'monitor_freistellung_validity' }));
    createTaskFromProposal(proposal({ taskKind: 'send_freistellung_to_client' }));
    createTaskFromProposal(proposal({ sourceId: 'inbox-other', linkedInboxId: 'inbox-other' }));
    expect(getAllTasksFromStore()).toHaveLength(3);
  });

  it('Workflow: eine Mahnung schlägt „Zahlung prüfen" genau einmal vor', () => {
    const item = { ...classifyInboxItem({
      recognizedText: 'Mahnung Zahlungsaufforderung Mustermann Sanitär GmbH',
      senderHint: 'Bauzentrum Nord GmbH',
    }), id: 'inbox-mahnung-01a', status: 'neu' as const };
    hydrateInboxStore([item]);
    const result = processUploadedDocument(item.id);
    expect(result?.classifiedKind).toBe('mahnung');
    const paymentChecks = result!.suggestedTasks.filter((task) => task.taskKind === 'payment_check');
    expect(paymentChecks).toHaveLength(1);
  });
});

describe('P1-3 — Werbungskosten sind keine Werbung', () => {
  it('negativ: Steuerschreiben mit „Werbungskosten" ist keine Werbung', () => {
    const result = classifyDocument({
      recognizedText: 'Finanzamt Berlin\nEinkommensteuerbescheid 2025\nWerbungskosten wurden in Höhe von 1.230,00 EUR anerkannt.',
      senderHint: 'Finanzamt Berlin',
    });
    expect(result.isAdvertisement).toBe(false);
    expect(result.detectionReasonKey).not.toBe('classification.detect.advertisement');
  });

  it('negativ: Rechnung mit Newsletter-Hinweis in der Fußzeile bleibt eine Rechnung', () => {
    const result = classifyDocument({
      recognizedText:
        'Rechnung\nRechnungsnummer: R-2026-441\nNetto 100,00 EUR USt 19,00 EUR Brutto 119,00 EUR\nAbonnieren Sie unseren Newsletter!',
    });
    expect(result.isAdvertisement).toBe(false);
  });

  it('positiv: echte Werbung wird weiterhin erkannt', () => {
    expect(classifyDocument({ recognizedText: 'Sommer-Sale! Unser neuer Prospekt ist da.' }).isAdvertisement).toBe(true);
    expect(classifyDocument({ recognizedText: 'Newsletter Oktober – Aktionsmail mit Rabatten' }).isAdvertisement).toBe(true);
    expect(classifyDocument({ kindHint: 'werbung', recognizedText: 'Sommer-Sale Prospekt' }).isAdvertisement).toBe(true);
  });
});
