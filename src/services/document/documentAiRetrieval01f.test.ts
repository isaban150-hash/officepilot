/**
 * DOKUMENT-ASSISTENT-01F — Abruf und Wiedervorlagen.
 *
 * Geprüft wird, was 01F neu entscheidet: welche Frage welchen Abruf auslöst,
 * dass eine bestätigte Verknüpfung einen Vorschlag schlägt, dass „zwei Tage
 * vorher" deterministisch gerechnet wird, dass bei zwei Fristen nicht geraten
 * wird, und dass ein Vorschlag für sich genommen nichts anlegt.
 *
 * Alle Beispiele sind frei erfunden.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectRetrievalIntents,
  buildOperationalLines,
} from './documentAiRetrievalService';
import {
  buildReminderProposal,
  looksLikeReminderAnswer,
  confirmReminderProposal,
  isReminderRequest,
  parseReminderTiming,
  resolveMeantDeadline,
  resolveRemindDate,
} from './documentReminderProposalService';
import { resetTasks, getAllTasksFromStore } from '../taskStore';
import { resetVorgaenge, hydrateVorgangStore } from '../vorgangService';
import type { InboxItem, Vorgang } from '../../types/models';
import type { DocumentSemanticCore, SemanticDeadline } from '../../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../../types/documentSemanticCore';

const ANTWORT: SemanticDeadline = {
  date: '2026-09-22', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected',
};
const LEISTUNG: SemanticDeadline = {
  date: '2026-09-30', type: 'service_due', appliesTo: 'Leistung', actionRequired: true, certainty: 'detected',
};

function kern(teile: Partial<DocumentSemanticCore> = {}): DocumentSemanticCore {
  return {
    ...emptyDocumentSemanticCore(),
    subject: { value: 'Maengelanzeige Gewerbepark Senne', certainty: 'detected' },
    deadlines: [ANTWORT, LEISTUNG],
    ...teile,
  };
}

function posten(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-1',
    title: 'Schreiben',
    documentType: 'sonstiges',
    sender: 'Westfalen Projektbau GmbH',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'klaeren',
    digitalFolder: { id: 'd', name: 'Eingang', path: '/Eingang/' },
    paperFiling: { folderId: 'f', register: 'A', label: 'Ordner' },
    status: 'neu',
    receivedAt: '2026-09-12T08:00:00.000Z',
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    ...overrides,
  } as InboxItem;
}



/** Ein Auftrag mit allen Sammlungen, die der Bestand beim Laden erwartet. */
function vorgang(): Vorgang {
  return {
    id: 'vg-1',
    title: 'Gewerbepark Senne',
    customer: 'Westfalen Projektbau GmbH',
    baustelle: 'Senne',
    status: 'in_arbeit',
    materialSource: 'standard',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
  } as unknown as Vorgang;
}
/** Nur die in diesem Block erzeugten Wiedervorlagen — der Bestand trägt Beispielaufgaben. */
function wiedervorlagen() {
  return getAllTasksFromStore().filter((task) => task.taskKind === 'document_reminder');
}

beforeEach(() => {
  resetTasks();
  resetVorgaenge();
});

describe('01F — welche Frage welchen Abruf auslöst', () => {
  it('erkennt Fragen nach dem Zahlungsstand', () => {
    expect(detectRetrievalIntents('Ist das schon bezahlt?')).toContain('payment');
    expect(detectRetrievalIntents('Wie viel ist noch offen?')).toContain('payment');
  });

  it('erkennt Fragen nach Auftrag, Kunde, Kommunikation und Aufgaben', () => {
    expect(detectRetrievalIntents('Zu welchem Auftrag gehört das?')).toContain('vorgang');
    expect(detectRetrievalIntents('Wer ist der Kunde dazu?')).toContain('customer');
    expect(detectRetrievalIntents('Haben wir dem schon geschrieben?')).toContain('communication');
    expect(detectRetrievalIntents('Gibt es dazu schon eine Aufgabe?')).toContain('tasks');
  });

  it('holt nichts, wenn die Frage nichts davon verlangt', () => {
    expect(detectRetrievalIntents('Was steht da drin?')).toEqual([]);
    expect(buildOperationalLines({ question: 'Was steht da drin?', item: posten() })).toEqual([]);
  });
});

describe('01F — Betriebsdaten statt Dokumenttext', () => {
  it('sagt ehrlich, dass kein Beleg hinterlegt ist', () => {
    const zeilen = buildOperationalLines({ question: 'Ist das schon bezahlt?', item: posten() });
    expect(zeilen.join(' ')).toContain('kein passender Beleg');
  });

  it('erfindet keinen Zahlungsstand aus einem Betrag im Schreiben', () => {
    const mitBetrag = kern({
      amounts: [
        { value: 4188.8, currency: 'EUR', role: 'invoice_total', isClaimAgainstUs: true, certainty: 'detected' },
      ],
    });
    const zeilen = buildOperationalLines({
      question: 'Ist das schon bezahlt?',
      item: posten(),
      core: mitBetrag,
    });
    expect(zeilen.join(' ')).not.toMatch(/bezahlt:|Zahlungsstand laut OfficeTakt/);
  });

  it('nennt einen bestätigt zugeordneten Auftrag', () => {
    hydrateVorgangStore([
      vorgang(),
    ]);
    const zeilen = buildOperationalLines({
      question: 'Zu welchem Auftrag gehört das?',
      item: posten({ vorgangId: 'vg-1', vorgangLinkStatus: 'linked' }),
      core: kern(),
    });
    expect(zeilen.join(' ')).toContain('Bestätigt zugeordneter Auftrag');
  });

  it('lässt einen unbestätigten Kandidaten Vorschlag bleiben', () => {
    const mitKandidat = kern({
      vorgangCandidates: [{ id: 'vg-9', name: 'Gewerbepark Senne', score: 1, reasons: ['Im Text.'] }],
    });
    const zeilen = buildOperationalLines({
      question: 'Zu welchem Auftrag gehört das?',
      item: posten(),
      core: mitKandidat,
    });
    expect(zeilen.join(' ')).toContain('noch kein Auftrag zugeordnet');
    expect(zeilen.join(' ')).toContain('unbestätigte Vorschläge');
  });

  it('meldet fehlende Kommunikation und fehlende Aufgaben ausdrücklich', () => {
    expect(
      buildOperationalLines({ question: 'Haben wir schon geschrieben?', item: posten() }).join(' '),
    ).toContain('keine ausgehende Nachricht');
    expect(
      buildOperationalLines({ question: 'Gibt es dazu eine Aufgabe?', item: posten() }).join(' '),
    ).toContain('keine offene Aufgabe');
  });
});

describe('01F — Wiedervorlage: Zeitpunkt deterministisch', () => {
  it('erkennt einen Wiedervorlagewunsch', () => {
    expect(isReminderRequest('Erinnere mich zwei Tage vorher.')).toBe(true);
    expect(isReminderRequest('Was steht da drin?')).toBe(false);
  });

  it('rechnet „zwei Tage vorher" gegen die Frist', () => {
    expect(resolveRemindDate(ANTWORT, parseReminderTiming('Erinnere mich zwei Tage vorher.'))).toBe(
      '2026-09-20',
    );
  });

  it('versteht „einen Tag vorher" und „eine Woche vorher"', () => {
    expect(resolveRemindDate(ANTWORT, parseReminderTiming('einen Tag vorher'))).toBe('2026-09-21');
    expect(resolveRemindDate(ANTWORT, parseReminderTiming('eine Woche vorher'))).toBe('2026-09-15');
  });

  it('übernimmt ein ausdrücklich genanntes Datum', () => {
    expect(resolveRemindDate(ANTWORT, parseReminderTiming('Erinnere mich am 21.09.2026'))).toBe(
      '2026-09-21',
    );
  });

  it('erinnert ohne nähere Angabe am Tag der Frist', () => {
    expect(resolveRemindDate(ANTWORT, parseReminderTiming('Erinnere mich daran.'))).toBe('2026-09-22');
  });
});

describe('01F — mehrere Fristen', () => {
  it('rät nicht, wenn zwei Fristen in Frage kommen', () => {
    const ergebnis = resolveMeantDeadline('Erinnere mich daran.', kern());
    expect(ergebnis && 'kind' in ergebnis && ergebnis.kind).toBe('needs_choice');
  });

  it('nimmt die benannte Frist, wenn der Benutzer sie nennt', () => {
    const antwort = resolveMeantDeadline('Erinnere mich an die Terminbestätigung.', kern());
    expect(antwort && 'deadline' in antwort && antwort.deadline.date).toBe('2026-09-22');

    const leistung = resolveMeantDeadline('Erinnere mich an die Mängelbeseitigung.', kern());
    expect(leistung && 'deadline' in leistung && leistung.deadline.date).toBe('2026-09-30');
  });

  it('nimmt die einzige Handlungsfrist ohne Rückfrage', () => {
    const einzig = resolveMeantDeadline('Erinnere mich daran.', kern({ deadlines: [ANTWORT] }));
    expect(einzig && 'deadline' in einzig && einzig.deadline.date).toBe('2026-09-22');
  });
});

describe('01F — Vorschlag und Bestätigung', () => {
  it('legt beim Vorschlagen nichts an', () => {
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich zwei Tage vor der Terminbestätigung.',
      item: posten(),
      core: kern(),
    });

    expect(ergebnis.kind).toBe('proposal');
    expect(wiedervorlagen()).toHaveLength(0);
  });

  it('nennt im Titel die Frist und im Termin die Erinnerung', () => {
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich zwei Tage vor der Terminbestätigung.',
      item: posten(),
      core: kern(),
    });
    if (ergebnis.kind !== 'proposal') throw new Error('kein Vorschlag');

    expect(ergebnis.value.remindOn).toBe('2026-09-20');
    expect(ergebnis.value.proposal.dueDate).toBe('2026-09-20');
    expect(ergebnis.value.proposal.title).toContain('22.09.2026');
    expect(ergebnis.value.deadline.date).toBe('2026-09-22');
  });

  it('legt erst auf Bestätigung genau eine Aufgabe an', () => {
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich zwei Tage vor der Terminbestätigung.',
      item: posten(),
      core: kern(),
    });
    if (ergebnis.kind !== 'proposal') throw new Error('kein Vorschlag');

    const erst = confirmReminderProposal(ergebnis.value.proposal);
    expect(erst.ok && erst.created).toBe(true);
    expect(wiedervorlagen()).toHaveLength(1);
  });

  it('erzeugt bei zweimaliger Bestätigung keine zweite Aufgabe', () => {
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich zwei Tage vor der Terminbestätigung.',
      item: posten(),
      core: kern(),
    });
    if (ergebnis.kind !== 'proposal') throw new Error('kein Vorschlag');

    confirmReminderProposal(ergebnis.value.proposal);
    const zweit = confirmReminderProposal(ergebnis.value.proposal);

    expect(zweit.ok && zweit.created).toBe(false);
    expect(wiedervorlagen()).toHaveLength(1);
  });

  it('verknüpft das Schreiben, aber bestätigt keinen Kandidaten', () => {
    const mitKandidat = kern({
      vorgangCandidates: [{ id: 'vg-9', name: 'Gewerbepark Senne', score: 1, reasons: ['Im Text.'] }],
    });
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich an die Terminbestätigung.',
      item: posten(),
      core: mitKandidat,
    });
    if (ergebnis.kind !== 'proposal') throw new Error('kein Vorschlag');

    expect(ergebnis.value.proposal.linkedInboxId).toBe('inbox-1');
    /* Der Kandidat darf nicht als Verknüpfung durchschlüpfen. */
    expect(ergebnis.value.proposal.linkedVorgangId).toBeUndefined();
  });

  it('übernimmt eine bereits bestätigte Auftragsverknüpfung', () => {
    hydrateVorgangStore([
      vorgang(),
    ]);
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich an die Terminbestätigung.',
      item: posten({ vorgangId: 'vg-1', vorgangLinkStatus: 'linked' }),
      core: kern(),
    });
    if (ergebnis.kind !== 'proposal') throw new Error('kein Vorschlag');
    expect(ergebnis.value.proposal.linkedVorgangId).toBe('vg-1');
  });

  it('kommt ohne semantischen Kern ohne Fehler aus', () => {
    const ergebnis = buildReminderProposal({
      text: 'Erinnere mich daran.',
      item: posten(),
      core: undefined,
    });
    expect(ergebnis.kind).toBe('no_deadline');
    expect(wiedervorlagen()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 01K-F1 — Folgeantwort auf die Rückfrage                             */
/* ------------------------------------------------------------------ */

/**
 * Der Fall aus der unabhängigen Abnahme: Erst der Wunsch, dann die Rückfrage,
 * dann die Antwort in einem **eigenen** Turn. Der zweite Text ist kein
 * Wiedervorlagewunsch — er ist die Antwort auf unsere Frage. Vorher wanderte
 * er an das Modell; jetzt entscheidet er die Frist, und der Vorlauf kommt aus
 * dem ursprünglichen Wunsch.
 */
describe('01K-F1 — Folgeantwort auf „welche Frist?"', () => {
  const WUNSCH = 'Erinnere mich zwei Tage vorher.';

  it('der Wunsch allein führt bei zwei Fristen zur Rückfrage', () => {
    expect(buildReminderProposal({ text: WUNSCH, item: posten(), core: kern() }).kind).toBe(
      'needs_choice',
    );
  });

  it('„30.09.2026" beantwortet die Rückfrage: Leistungsfrist, Vorschlag 28.09.2026', () => {
    const ergebnis = buildReminderProposal({
      text: '30.09.2026',
      item: posten(),
      core: kern(),
      pendingRequest: WUNSCH,
    });
    if (ergebnis.kind !== 'proposal') throw new Error(`kein Vorschlag: ${ergebnis.kind}`);
    expect(ergebnis.value.deadline.date).toBe('2026-09-30');
    expect(ergebnis.value.remindOn).toBe('2026-09-28');
  });

  it('„22.09.2026" ebenso: Antwortfrist, Vorschlag 20.09.2026', () => {
    const ergebnis = buildReminderProposal({
      text: '22.09.2026',
      item: posten(),
      core: kern(),
      pendingRequest: WUNSCH,
    });
    if (ergebnis.kind !== 'proposal') throw new Error(`kein Vorschlag: ${ergebnis.kind}`);
    expect(ergebnis.value.remindOn).toBe('2026-09-20');
  });

  it('der Vorlauf bleibt der des ursprünglichen Wunsches — auch eine Woche', () => {
    const ergebnis = buildReminderProposal({
      text: 'die Antwortfrist',
      item: posten(),
      core: kern(),
      pendingRequest: 'Erinnere mich eine Woche vorher.',
    });
    if (ergebnis.kind !== 'proposal') throw new Error(`kein Vorschlag: ${ergebnis.kind}`);
    expect(ergebnis.value.remindOn).toBe('2026-09-15');
  });

  it('die Fristen lassen sich auch beim Namen nennen', () => {
    const ergebnis = buildReminderProposal({
      text: 'die Leistungsfrist',
      item: posten(),
      core: kern(),
      pendingRequest: WUNSCH,
    });
    expect(ergebnis.kind === 'proposal' && ergebnis.value.deadline.date).toBe('2026-09-30');
  });

  it('eine uneindeutige Antwort führt weiterhin zur Rückfrage — es wird nicht geraten', () => {
    for (const antwort of ['später', 'die Frist', 'ja']) {
      const ergebnis = buildReminderProposal({
        text: antwort,
        item: posten(),
        core: kern(),
        pendingRequest: WUNSCH,
      });
      expect(ergebnis.kind, antwort).toBe('needs_choice');
    }
  });

  it('ohne offene Rückfrage bleibt ein blosses Datum keine Wiedervorlage', () => {
    expect(buildReminderProposal({ text: '30.09.2026', item: posten(), core: kern() }).kind).toBe(
      'not_a_reminder',
    );
  });

  it('kurz und ohne Fragezeichen gilt als Antwort, eine echte Frage nicht', () => {
    expect(looksLikeReminderAnswer('30.09.2026')).toBe(true);
    expect(looksLikeReminderAnswer('die Leistungsfrist')).toBe(true);
    expect(looksLikeReminderAnswer('Wie hoch ist der Betrag auf diesem Dokument?')).toBe(false);
  });

  it('auch nach der Folgeantwort entsteht vor der Bestätigung keine Aufgabe', () => {
    const ergebnis = buildReminderProposal({
      text: '30.09.2026',
      item: posten(),
      core: kern(),
      pendingRequest: WUNSCH,
    });
    expect(ergebnis.kind).toBe('proposal');
    expect(wiedervorlagen()).toHaveLength(0);
  });
});
