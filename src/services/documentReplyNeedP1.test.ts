/**
 * P1 EINGANGSSCHREIBEN Phase 1 — die eine Antwortbedarf-Wahrheit.
 *
 *  A  erkannte echte Antwortfrist → Antwort erforderlich (mit Datum)
 *  B  Zahlungsfrist → kein Antwortbedarf
 *  C  Altbestand ohne belastbaren Typ (kein Analyse-Ergebnis, nur Fristtyp) und
 *     die Ersatzregel „bis zum …" → kein erfundener Antwortbedarf
 *  D  response_due/communication_request nach dem bestehenden semantischen Vertrag
 *     (auch gegen den echten semantischen Kern geprüft)
 *  Q  „Keine Antwort nötig" schliesst den Antwortbedarf; „beantwortet" ebenso
 *  T  Lebenszyklus, Dokumenterklärung und Assistent geben dieselbe Antwort
 *  —  das jüngste Statusereignis über Eingang und Dokument entscheidet
 *  —  Werbung und eigene ausgehende Schreiben verlangen keine Antwort
 *  R  nach Persistieren und Neuladen bleibt die Ableitung gleich
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type { CommunicationEvent } from '../types/communicationHistory';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import type { SemanticDeadline } from '../types/documentSemanticCore';
import type { CompanyDocument, InboxItem } from '../types/models';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { hydrateInboxStore } from './inboxService';
import { hydrateDocumentStore } from './documentService';
import { hydrateDocumentWorkResultStore } from './documentWorkResultStoreService';
import { setCommunicationHistoryStoreForTests } from './communicationHistoryStore';
import { recordMarkedAnswered, recordMarkedNoReplyNeeded } from './communicationHistoryService';
import {
  isGenuineResponseDeadline,
  resolveDocumentReplyNeed,
  toLifecycleReplyStatus,
} from './documentReplyNeedService';
import { resolveDocumentLifecycle } from './documentLifecycleService';
import { buildDocumentExplanation } from './memory/documentExplanationService';
import { answerMemoryQuestion } from './memory/memoryQueryService';
import { buildDocumentSemanticCore } from './document/documentSemanticCoreService';
import { clearInMemoryBusinessState, persistAll } from './persistenceService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import { addBusinessLetter, listBusinessLetters } from './businessLetterService';

const TODAY = '2026-10-07';

function antwortFrist(date = '2026-10-20'): SemanticDeadline {
  return { date, type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' };
}
function zahlungsFrist(date = '2026-10-20'): SemanticDeadline {
  return { date, type: 'payment_due', appliesTo: 'Zahlung', actionRequired: true, certainty: 'detected' };
}
function ersatzFrist(date = '2026-10-20'): SemanticDeadline {
  return { date, type: 'response_due', appliesTo: 'Handlung', actionRequired: true, certainty: 'uncertain' };
}

function deutung(input: {
  deadlines?: SemanticDeadline[];
  primaryCase?: string;
  complaintDirection?: 'incoming' | 'outgoing';
}): BusinessInterpretationResult {
  return {
    operational: { primaryCase: input.primaryCase ?? 'communication_information', meanings: [], nextStep: '', confirmRequirement: '', certainty: 'detected' },
    semantic: {
      deadlines: input.deadlines ?? [],
      ...(input.complaintDirection ? { complaint: { direction: input.complaintDirection } } : {}),
    },
  } as unknown as BusinessInterpretationResult;
}

function arbeitsergebnis(inboxItemId: string, interpretation: BusinessInterpretationResult): DocumentWorkResult {
  return {
    schemaVersion: 1,
    inboxItemId,
    analyzedAt: '2026-10-07T09:00:00.000Z',
    analysisVersion: 'p1-test',
    sourceFingerprint: `fp-${inboxItemId}`,
    businessInterpretation: interpretation,
    specialistRefs: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: true,
      hasDocumentUnderstanding: true,
      companyRelevant: true,
    },
    overlay: [],
  };
}

function schreiben(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id,
    title: `Schreiben ${id}`,
    documentType: 'brief',
    classifiedKind: 'brief',
    sender: 'Stadtwerke Musterstadt',
    deadline: null,
    ...overrides,
  });
}

function archiv(id: string, sourceInboxItemId: string, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  const vorlage = createAuftragInboxItem();
  return {
    id,
    title: `Archiv ${id}`,
    category: 'sonstiges',
    issuer: 'Stadtwerke Musterstadt',
    recognizedText: 'Text',
    issueDate: '2026-10-05',
    validUntil: null,
    digitalFolder: vorlage.digitalFolder,
    paperFolder: vorlage.paperFiling,
    tags: [],
    linkedCompany: 'Eigene Firma',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-10-06T10:00:00.000Z',
    sourceInboxItemId,
    ...overrides,
  } as CompanyDocument;
}

function ereignis(
  id: string,
  type: CommunicationEvent['type'],
  contextRef: CommunicationEvent['contextRef'],
  timestamp: string,
): CommunicationEvent {
  return { id, type, contextRef, timestamp, status: 'complete', disclaimerShown: false };
}

beforeEach(() => {
  resetTestStores();
  setCommunicationHistoryStoreForTests([]);
});

describe('P1 — Antwortbedarf aus vorhandener Wahrheit', () => {
  it('A — eine echte Antwortfrist ergibt „Antwort erforderlich" mit Datum', () => {
    hydrateInboxStore([schreiben('in-a', { deadline: '2026-10-20', deadlineType: 'response_due' })]);
    hydrateDocumentWorkResultStore([arbeitsergebnis('in-a', deutung({ deadlines: [antwortFrist('2026-10-20')] }))]);

    const need = resolveDocumentReplyNeed({ inboxId: 'in-a' });
    expect(need.state).toBe('open');
    expect(need.reason).toBe('response_deadline');
    expect(need.recognized).toBe(true);
    expect(need.dueDate).toBe('2026-10-20');
    expect(resolveDocumentLifecycle({ inboxId: 'in-a' }, TODAY)?.openReasons).toContain('reply_open');
  });

  it('B — eine Zahlungsfrist ist keine Antwortfrist', () => {
    hydrateInboxStore([schreiben('in-b', { deadline: '2026-10-20', deadlineType: 'payment_due', classifiedKind: 'mahnung' })]);
    hydrateDocumentWorkResultStore([arbeitsergebnis('in-b', deutung({ deadlines: [zahlungsFrist()] }))]);

    const need = resolveDocumentReplyNeed({ inboxId: 'in-b' });
    expect(need.state).toBe('not_required');
    expect(need.recognized).toBe(false);
    expect(resolveDocumentLifecycle({ inboxId: 'in-b' }, TODAY)?.openReasons).not.toContain('reply_open');
  });

  it('C — Altbestand ohne Analyse-Ergebnis und die Ersatzregel „bis zum …" erfinden keinen Antwortbedarf', () => {
    hydrateInboxStore([
      // nur Frist und Fristtyp am Eingang, kein gespeichertes Analyse-Ergebnis
      schreiben('in-alt', { deadline: '2026-10-20', deadlineType: 'response_due' }),
      schreiben('in-ersatz', { deadline: '2026-10-20', deadlineType: 'response_due' }),
    ]);
    hydrateDocumentWorkResultStore([arbeitsergebnis('in-ersatz', deutung({ deadlines: [ersatzFrist()] }))]);

    expect(resolveDocumentReplyNeed({ inboxId: 'in-alt' }).state).toBe('not_required');
    expect(resolveDocumentReplyNeed({ inboxId: 'in-ersatz' }).state).toBe('not_required');
    expect(isGenuineResponseDeadline(ersatzFrist())).toBe(false);
    expect(resolveDocumentLifecycle({ inboxId: 'in-alt' }, TODAY)?.openReasons).not.toContain('reply_open');
  });

  it('D — communication_request ergibt Antwortbedarf ohne erfundenes Datum', () => {
    hydrateInboxStore([schreiben('in-d')]);
    hydrateDocumentWorkResultStore([arbeitsergebnis('in-d', deutung({ primaryCase: 'communication_request' }))]);

    const need = resolveDocumentReplyNeed({ inboxId: 'in-d' });
    expect(need.state).toBe('open');
    expect(need.reason).toBe('communication_request');
    expect(need.dueDate).toBeUndefined();
  });

  it('D — der echte semantische Kern trennt Antwortregel und Ersatzregel', () => {
    const echt = buildDocumentSemanticCore({
      text: 'Sehr geehrte Damen und Herren,\nbitte nehmen Sie bis zum 20.10.2026 Stellung zu dem Vorgang.',
      companyProfile: null,
    });
    expect(echt.deadlines.some(isGenuineResponseDeadline)).toBe(true);

    const zahlung = buildDocumentSemanticCore({
      text: 'Bitte überweisen Sie den offenen Betrag bis zum 20.10.2026.',
      companyProfile: null,
    });
    expect(zahlung.deadlines.some(isGenuineResponseDeadline)).toBe(false);
    expect(zahlung.deadlines.some((frist) => frist.type === 'payment_due')).toBe(true);
  });

  it('Q — „Keine Antwort nötig" und „beantwortet" schliessen den Antwortbedarf', () => {
    hydrateInboxStore([schreiben('in-q1'), schreiben('in-q2')]);
    hydrateDocumentWorkResultStore([
      arbeitsergebnis('in-q1', deutung({ deadlines: [antwortFrist()] })),
      arbeitsergebnis('in-q2', deutung({ deadlines: [antwortFrist()] })),
    ]);

    recordMarkedNoReplyNeeded({ type: 'inbox', id: 'in-q1' });
    recordMarkedAnswered({ type: 'inbox', id: 'in-q2' }, undefined, {
      channel: 'letter',
      answerRef: { kind: 'letter', id: 'letter-q2' },
    });

    const keine = resolveDocumentReplyNeed({ inboxId: 'in-q1' });
    expect(keine.state).toBe('no_reply_needed');
    const beantwortet = resolveDocumentReplyNeed({ inboxId: 'in-q2' });
    expect(beantwortet.state).toBe('answered');
    expect(beantwortet.decisiveEvent?.answerRef).toEqual({ kind: 'letter', id: 'letter-q2' });
    expect(beantwortet.decisiveEvent?.channel).toBe('letter');
    for (const id of ['in-q1', 'in-q2']) {
      expect(resolveDocumentLifecycle({ inboxId: id }, TODAY)?.openReasons).not.toContain('reply_open');
    }
    // Die Frist selbst bleibt unangetastet.
    expect(beantwortet.dueDate).toBe('2026-10-20');
  });

  it('das jüngste Statusereignis über Eingang und Dokument entscheidet', () => {
    hydrateInboxStore([schreiben('in-k', { importedToArchive: true, archiveDocumentId: 'doc-k' })]);
    hydrateDocumentStore([archiv('doc-k', 'in-k')]);
    hydrateDocumentWorkResultStore([arbeitsergebnis('in-k', deutung({ deadlines: [antwortFrist()] }))]);
    setCommunicationHistoryStoreForTests([
      ereignis('e-1', 'marked_remind_later', { type: 'inbox', id: 'in-k' }, '2026-10-07T08:00:00.000Z'),
      ereignis('e-2', 'marked_no_reply_needed', { type: 'document', id: 'doc-k' }, '2026-10-07T09:00:00.000Z'),
    ]);
    expect(resolveDocumentReplyNeed({ inboxId: 'in-k' }).state).toBe('no_reply_needed');
    expect(resolveDocumentReplyNeed({ documentId: 'doc-k' }).state).toBe('no_reply_needed');

    setCommunicationHistoryStoreForTests([
      ereignis('e-1', 'marked_no_reply_needed', { type: 'document', id: 'doc-k' }, '2026-10-07T08:00:00.000Z'),
      ereignis('e-2', 'marked_remind_later', { type: 'inbox', id: 'in-k' }, '2026-10-07T09:00:00.000Z'),
    ]);
    expect(resolveDocumentReplyNeed({ documentId: 'doc-k' }).state).toBe('open');
  });

  it('Werbung und eigene ausgehende Schreiben verlangen keine Antwort', () => {
    hydrateInboxStore([schreiben('in-werbung', { isAdvertisement: true }), schreiben('in-eigen')]);
    hydrateDocumentWorkResultStore([
      arbeitsergebnis('in-werbung', deutung({ deadlines: [antwortFrist()] })),
      arbeitsergebnis('in-eigen', deutung({ deadlines: [antwortFrist()], complaintDirection: 'outgoing' })),
    ]);
    expect(resolveDocumentReplyNeed({ inboxId: 'in-werbung' }).state).toBe('not_required');
    expect(resolveDocumentReplyNeed({ inboxId: 'in-eigen' }).state).toBe('not_required');
  });

  it('„Später erinnern" hält ohne Inhaltsbefund offen — bestehender Vertrag', () => {
    hydrateInboxStore([schreiben('in-spaeter')]);
    setCommunicationHistoryStoreForTests([
      ereignis('e-s', 'marked_remind_later', { type: 'inbox', id: 'in-spaeter' }, '2026-10-07T08:00:00.000Z'),
    ]);
    const need = resolveDocumentReplyNeed({ inboxId: 'in-spaeter' });
    expect(need.state).toBe('open');
    expect(need.reason).toBe('user_reopened');
  });
});

describe('P1 — R: nach Persistieren und Neuladen', () => {
  it('Antwortstatus samt Nachweis, Analyse-Ergebnis und Brief-Herkunft überstehen den Neustart', () => {
    bootstrapBusinessState({ userId: 'user-p1', workspaceId: 'ws-p1-reload' });
    hydrateInboxStore([schreiben('in-r')]);
    hydrateDocumentWorkResultStore([arbeitsergebnis('in-r', deutung({ deadlines: [antwortFrist()] }))]);
    const brief = addBusinessLetter('ws-p1-reload', {
      subject: 'Ihr Schreiben – Antwort',
      body: 'Text',
      recipient: { name: 'Stadtwerke Musterstadt', street: '', zip: '', city: '' },
      replyTo: { type: 'inbox', id: 'in-r' },
    });
    expect(brief.success).toBe(true);
    if (!brief.success) return;
    recordMarkedAnswered({ type: 'inbox', id: 'in-r' }, undefined, {
      channel: 'letter',
      answerRef: { kind: 'letter', id: brief.letter.id },
    });
    persistAll();

    clearInMemoryBusinessState();
    expect(resolveDocumentReplyNeed({ inboxId: 'in-r' }).state).toBe('not_required');

    bootstrapBusinessState({ userId: 'user-p1', workspaceId: 'ws-p1-reload' });
    const need = resolveDocumentReplyNeed({ inboxId: 'in-r' });
    expect(need.state).toBe('answered');
    expect(need.decisiveEvent?.answerRef).toEqual({ kind: 'letter', id: brief.letter.id });
    expect(need.dueDate).toBe('2026-10-20');
    expect(listBusinessLetters().find((entry) => entry.id === brief.letter.id)?.replyTo).toEqual({ type: 'inbox', id: 'in-r' });
  });
});

describe('P1 — T: Lebenszyklus, Erklärung und Assistent lesen dieselbe Wahrheit', () => {
  function archivierterBrief(id: string, interpretation: BusinessInterpretationResult) {
    hydrateInboxStore([schreiben(`in-${id}`, { importedToArchive: true, archiveDocumentId: `doc-${id}` })]);
    hydrateDocumentStore([archiv(`doc-${id}`, `in-${id}`)]);
    hydrateDocumentWorkResultStore([arbeitsergebnis(`in-${id}`, interpretation)]);
  }

  it('ohne Befund und ohne Ereignis: weder Lebenszyklus noch Erklärung noch Assistent behaupten eine offene Antwort', () => {
    archivierterBrief('t0', deutung({ deadlines: [zahlungsFrist()] }));

    expect(toLifecycleReplyStatus(resolveDocumentReplyNeed({ documentId: 'doc-t0' }))).toBe('no_reply_needed');
    expect(resolveDocumentLifecycle({ documentId: 'doc-t0' }, TODAY)?.openReasons).not.toContain('reply_open');
    const erklaerung = buildDocumentExplanation({ documentId: 'doc-t0' }, TODAY);
    expect(erklaerung?.communicationStatus).toBeUndefined();
    expect(erklaerung?.nextSteps ?? []).not.toContain('Antwort vorbereiten oder als erledigt markieren.');
    expect(answerMemoryQuestion('reply_status', 'Habe ich schon geantwortet?', TODAY)).toBeNull();
  });

  it('mit echter Antwortfrist: alle drei melden „Antwort offen"', () => {
    archivierterBrief('t1', deutung({ deadlines: [antwortFrist()] }));

    expect(resolveDocumentLifecycle({ documentId: 'doc-t1' }, TODAY)?.openReasons).toContain('reply_open');
    const erklaerung = buildDocumentExplanation({ documentId: 'doc-t1' }, TODAY);
    expect(erklaerung?.communicationStatus).toBe('Antwort offen');
    expect(erklaerung?.nextSteps).toContain('Antwort vorbereiten oder als erledigt markieren.');
    expect(answerMemoryQuestion('reply_status', 'Habe ich schon geantwortet?', TODAY)?.shortAnswer).toContain('noch eine Antwort offen');
  });

  it('nach „beantwortet": alle drei melden keinen offenen Antwortbedarf mehr', () => {
    archivierterBrief('t2', deutung({ deadlines: [antwortFrist()] }));
    recordMarkedAnswered({ type: 'document', id: 'doc-t2' });

    expect(resolveDocumentLifecycle({ documentId: 'doc-t2' }, TODAY)?.openReasons).not.toContain('reply_open');
    expect(buildDocumentExplanation({ documentId: 'doc-t2' }, TODAY)?.communicationStatus).toBe('Als erledigt markiert');
    expect(answerMemoryQuestion('reply_status', 'Habe ich schon geantwortet?', TODAY)?.shortAnswer).toContain('als beantwortet markiert');
  });
});
