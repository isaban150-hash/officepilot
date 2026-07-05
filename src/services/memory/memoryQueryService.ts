import type { AssistantAction, AssistantAnswer } from '../../types/models';
import type { DocumentMemory, MemoryQueryAnswer } from '../../types/memory';
import { getCommunicationReplyStatus } from '../communicationHistoryService';
import { getAllDocuments } from '../documentService';
import {
  formatPaperFilingInstruction,
  formatPaperLocationSummary,
  getPhysicalFilingStatusLabel,
} from '../paperFolderService';
import {
  computeProofStatus,
  getAllDocumentMemories,
  getPaperRegisterEntryForDocument,
  getProofMemories,
} from '../officePilotMemoryService';
import { getTodayIso } from '../taskNormalize';
import { formatDigitalLocation, formatPaperLocation } from './documentSummaryService';
import {
  buildDocumentExplanation,
  documentExplanationToMemoryQueryAnswer,
  findDocumentForExplanationQuestion,
} from './documentExplanationService';

export type MemoryQueryIntent =
  | 'freistellung_location'
  | 'freistellung_explanation'
  | 'document_explanation'
  | 'action_required'
  | 'paper_filing'
  | 'original_location'
  | 'physical_filed_status'
  | 'which_register'
  | 'which_folder'
  | 'expiry'
  | 'bg_bau_content'
  | 'missing_proofs'
  | 'expiring_proofs'
  | 'finanzamt_letters'
  | 'reply_status';

const PROOF_LABELS: Record<string, string> = {
  freistellungsbescheinigung: 'Freistellungsbescheinigung §48b',
  bg_bau: 'BG BAU Unbedenklichkeitsbescheinigung',
  soka_bau: 'SOKA-BAU',
  betriebshaftpflicht: 'Betriebshaftpflicht',
};

const REPLY_STATUS_LABELS: Record<string, string> = {
  needs_reply: 'Antwort ausstehend',
  draft_ready: 'Entwurf bereit',
  copied: 'Antwort kopiert – Versand prüfen',
  answered: 'Als beantwortet markiert',
  no_reply_needed: 'Keine Antwort nötig',
};

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .trim()
    .replace(/[^\wäöüß0-9\s?]/gi, ' ')
    .replace(/\s+/g, ' ');
}

export function detectMemoryQueryIntent(question: string): MemoryQueryIntent | null {
  const q = normalizeQuestion(question);

  if (/was ist mit.*freistellung|freistellung.*(status|bedeutet|gültig|gueltig)/.test(q)) {
    return 'freistellung_explanation';
  }
  if (/was bedeutet.*(brief|schreiben|dokument)|bedeutet der brief/.test(q)) {
    return 'document_explanation';
  }
  if (/was muss ich tun|muss ich etwas tun|was soll ich tun/.test(q)) {
    return 'action_required';
  }
  if (/wo liegt.*freistellung|freistellung.*(liegt|ablage|speicher|archiv)/.test(q)) {
    return 'freistellung_location';
  }
  if (/wo liegt.*original|original.*(liegt|ablage|ordner|speicher)/.test(q)) {
    return 'original_location';
  }
  if (/habe ich.*(abgeheftet|abheft)|original abgeheftet|schon abgeheftet/.test(q)) {
    return 'physical_filed_status';
  }
  if (/in welches register|welches register/.test(q)) {
    return 'which_register';
  }
  if (/in welchen ordner|welchen ordner|wo muss ich.*(abheften|ablegen)/.test(q)) {
    return 'which_folder';
  }
  if (/original abheften|papierordner/.test(q)) {
    return 'paper_filing';
  }
  if (/wann läuft|ablauf|gültig bis|gueltig bis/.test(q) && /dokument|nachweis|freistellung|bescheinigung/.test(q)) {
    return 'expiry';
  }
  if (/was wollte.*bg|bg bau.*(wollte|schreiben|brief)|bg[\s-]?bau/.test(q)) {
    return 'bg_bau_content';
  }
  if (/nachweise fehlen|fehlende nachweise|welche nachweise fehlen/.test(q)) {
    return 'missing_proofs';
  }
  if (/nachweise.*(bald|laufen ab|ablaufend)|bald ablaufende nachweise/.test(q)) {
    return 'expiring_proofs';
  }
  if (/schreiben.*finanzamt|finanzamt.*schreiben|vom finanzamt/.test(q)) {
    return 'finanzamt_letters';
  }
  if (/beantwortet|schon geantwortet|habe ich.*antwort|antwort.*schon/.test(q)) {
    return 'reply_status';
  }

  return null;
}

function findFreistellungMemories() {
  return getAllDocumentMemories().filter(
    (item) =>
      item.proofType === 'freistellungsbescheinigung' ||
      item.classifiedKind === 'freistellungsbescheinigung' ||
      /freistellung/i.test(item.title),
  );
}

function findBgBauMemories() {
  return getAllDocumentMemories().filter(
    (item) =>
      item.classifiedKind === 'bg_bau' ||
      item.classifiedKind === 'berufsgenossenschaft' ||
      item.proofType === 'bg_bau' ||
      item.relatedAuthorities?.includes('bg_bau') ||
      /bg[\s-]?bau|unbedenklichkeit/i.test(`${item.title} ${item.issuer}`),
  );
}

function findFinanzamtMemories() {
  return getAllDocumentMemories().filter(
    (item) =>
      item.relatedAuthorities?.includes('finanzamt') ||
      item.classifiedKind === 'finanzamt' ||
      item.classifiedKind === 'steuerbescheid' ||
      item.classifiedKind === 'freistellungsbescheinigung' ||
      /finanzamt/i.test(item.issuer),
  );
}

function findMemoryForQuestion(question: string): DocumentMemory | null {
  const q = normalizeQuestion(question);
  const memories = getAllDocumentMemories();
  if (memories.length === 0) return null;

  if (/freistellung/.test(q)) {
    return findFreistellungMemories()[0] ?? null;
  }
  if (/bg[\s-]?bau|unbedenklichkeit/.test(q)) {
    return findBgBauMemories()[0] ?? null;
  }
  if (/finanzamt/.test(q)) {
    return findFinanzamtMemories()[0] ?? null;
  }

  const byTitle = memories.find((item) => q.includes(item.title.toLowerCase().slice(0, 12)));
  return byTitle ?? memories[0]!;
}

function memoryPaperLocation(memory: DocumentMemory): string {
  if (!memory.paperFolder?.folderId && !memory.paperFolder?.label) {
    return 'Kein Papierordner hinterlegt – bitte Ablage prüfen.';
  }
  return formatPaperFilingInstruction(memory.paperFolder);
}

function memoryRegister(memory: DocumentMemory): string {
  const entry = getPaperRegisterEntryForDocument(memory.documentId);
  if (entry?.register) return entry.register;
  if (memory.paperFolder?.register) return memory.paperFolder.register;
  return 'Kein Register hinterlegt.';
}

function memoryDigitalLocation(memory: DocumentMemory): string {
  const name = memory.digitalFolder?.name?.trim();
  if (!memory.digitalFolder?.path) return 'Kein digitaler Speicherort hinterlegt.';
  return name ? `${name} (${memory.digitalFolder.path})` : memory.digitalFolder.path;
}

function memoryPhysicalStatus(memory: DocumentMemory): string {
  const entry = getPaperRegisterEntryForDocument(memory.documentId);
  const physicalFiled = memory.physicalFiled ?? entry?.physicalFiled ?? false;
  const filedAt = memory.filedAt ?? entry?.filedAt;
  const label = getPhysicalFilingStatusLabel(physicalFiled, filedAt);
  if (label.statusKey === 'document.filing.statusFiled' && label.filedAtLabel) {
    return `Original abgeheftet am ${label.filedAtLabel}`;
  }
  return physicalFiled ? 'Original abgeheftet' : 'Original noch abheften';
}

function memoryNextFilingStep(memory: DocumentMemory): string {
  const entry = getPaperRegisterEntryForDocument(memory.documentId);
  const physicalFiled = memory.physicalFiled ?? entry?.physicalFiled ?? false;
  if (physicalFiled) {
    return 'Kein weiterer Schritt – Original ist abgeheftet.';
  }
  if (!memory.paperFolder?.folderId) {
    return 'Papierablage prüfen oder Original entsorgen.';
  }
  return 'Original im Papierordner abheften und in OfficePilot bestätigen.';
}

function answerFreistellungLocation(): MemoryQueryAnswer | null {
  const memories = findFreistellungMemories();
  if (memories.length === 0) return null;

  const memory = memories[0]!;
  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const digital = doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory);
  const paper = doc ? formatPaperLocation(doc) : memoryPaperLocation(memory);
  const register = memoryRegister(memory);
  const status = memory.validUntil
    ? `Gültig bis ${memory.validUntil.slice(0, 10)} · ${memoryPhysicalStatus(memory)}`
    : memoryPhysicalStatus(memory);

  return {
    shortAnswer:
      memories.length === 1
        ? `Ihre Freistellungsbescheinigung liegt digital unter ${digital}.`
        : `${memories.length} Freistellungsbescheinigungen im Firmen-Gedächtnis.`,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: digital,
    paperLocation: paper,
    register,
    status,
    nextStep: memory.nextAction ?? memory.summary?.nextAction ?? memoryNextFilingStep(memory),
    uncertainty: memories.length > 1 ? 'Mehrere Freistellungen gefunden – neueste zuerst genannt.' : undefined,
  };
}

function answerPaperFiling(question: string): MemoryQueryAnswer | null {
  const memory = findMemoryForQuestion(question);
  if (!memory) return null;

  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const paper = doc ? formatPaperLocation(doc) : memoryPaperLocation(memory);
  const register = memoryRegister(memory);

  return {
    shortAnswer: paper,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory),
    paperLocation: paper,
    register,
    status: memoryPhysicalStatus(memory),
    nextStep: memoryNextFilingStep(memory),
    uncertainty: !doc?.paperFolder?.folderId ? 'Papierordner nicht vollständig hinterlegt.' : undefined,
  };
}

function answerOriginalLocation(question: string): MemoryQueryAnswer | null {
  const memory = findMemoryForQuestion(question);
  if (!memory) return null;

  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const paper = doc ? formatPaperLocation(doc) : memoryPaperLocation(memory);
  const register = memoryRegister(memory);
  const physical = memoryPhysicalStatus(memory);

  return {
    shortAnswer: `Das Original gehört in ${formatPaperLocationSummary(memory.paperFolder)}.`,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory),
    paperLocation: paper,
    register,
    status: physical,
    nextStep: memoryNextFilingStep(memory),
  };
}

function answerPhysicalFiledStatus(question: string): MemoryQueryAnswer | null {
  const memory = findMemoryForQuestion(question);
  if (!memory) return null;

  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const physical = memoryPhysicalStatus(memory);
  const filed = /abgeheftet/.test(physical) && !/noch abheften/.test(physical);

  return {
    shortAnswer: filed
      ? `Ja, „${memory.title}“ ist als abgeheftet markiert.`
      : `Nein, „${memory.title}“ ist noch nicht als abgeheftet markiert.`,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory),
    paperLocation: doc ? formatPaperLocation(doc) : memoryPaperLocation(memory),
    register: memoryRegister(memory),
    status: physical,
    nextStep: memoryNextFilingStep(memory),
  };
}

function answerWhichRegister(question: string): MemoryQueryAnswer | null {
  const memory = findMemoryForQuestion(question);
  if (!memory) return null;

  const register = memoryRegister(memory);
  const doc = getAllDocuments().find((item) => item.id === memory.documentId);

  return {
    shortAnswer: `Register: ${register}`,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory),
    paperLocation: doc ? formatPaperLocation(doc) : memoryPaperLocation(memory),
    register,
    status: memoryPhysicalStatus(memory),
    nextStep: memoryNextFilingStep(memory),
  };
}

function answerWhichFolder(question: string): MemoryQueryAnswer | null {
  const memory = findMemoryForQuestion(question);
  if (!memory) return null;

  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const paper = doc ? formatPaperLocation(doc) : memoryPaperLocation(memory);
  const folderName = memory.paperFolder?.label ?? 'Unbekannt';

  return {
    shortAnswer: `Ordner: ${folderName}`,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory),
    paperLocation: paper,
    register: memoryRegister(memory),
    status: memoryPhysicalStatus(memory),
    nextStep: memoryNextFilingStep(memory),
  };
}

function answerExpiry(todayIso: string): MemoryQueryAnswer | null {
  const proofs = getProofMemories().filter((item) => item.validUntil && item.status !== 'missing');
  if (proofs.length === 0) return null;

  const sorted = [...proofs].sort(
    (a, b) => (a.validUntil ?? '').localeCompare(b.validUntil ?? ''),
  );
  const next = sorted[0]!;
  const memory = next.documentMemoryId
    ? getAllDocumentMemories().find((item) => item.id === next.documentMemoryId)
    : getAllDocumentMemories().find((item) => item.documentId === next.documentId);

  const label = PROOF_LABELS[next.proofType] ?? next.proofType;
  const status = computeProofStatus(next.validUntil, todayIso);

  return {
    shortAnswer: `${label} läuft am ${next.validUntil!.slice(0, 10)} ab.`,
    source: memory ? `Firmen-Gedächtnis: ${memory.title}` : `Nachweis: ${label}`,
    digitalLocation: memory ? memoryDigitalLocation(memory) : 'Kein digitaler Speicherort hinterlegt.',
    paperLocation: memory ? memoryPaperLocation(memory) : 'Kein Papierordner hinterlegt.',
    register: memory ? memoryRegister(memory) : '—',
    status:
      status === 'expired'
        ? 'Abgelaufen'
        : status === 'expiring'
          ? 'Läuft bald ab'
          : 'Gültig',
    nextStep: memory?.nextAction ?? 'Erneuerung rechtzeitig einplanen.',
  };
}

function answerFromExplanation(question: string): MemoryQueryAnswer | null {
  const explanation = findDocumentForExplanationQuestion(question);
  if (!explanation) return null;
  return documentExplanationToMemoryQueryAnswer(explanation);
}

function answerDocumentExplanation(question: string): MemoryQueryAnswer | null {
  return answerFromExplanation(question);
}

function answerActionRequired(question: string): MemoryQueryAnswer | null {
  const explanation = findDocumentForExplanationQuestion(question);
  if (!explanation) return null;
  const answer = documentExplanationToMemoryQueryAnswer(explanation);
  return {
    ...answer,
    shortAnswer: explanation.actionRequired,
    nextStep: explanation.nextSteps.join(' '),
  };
}

function answerFreistellungExplanation(): MemoryQueryAnswer | null {
  const memory = findFreistellungMemories()[0];
  if (!memory) return null;
  const explanation = buildDocumentExplanation({ documentId: memory.documentId });
  if (!explanation) return null;
  return documentExplanationToMemoryQueryAnswer(explanation);
}

function answerBgBauContent(): MemoryQueryAnswer | null {
  const memory = findBgBauMemories()[0];
  if (!memory) return null;
  const explanation = buildDocumentExplanation({ documentId: memory.documentId });
  if (!explanation) return null;
  return {
    ...documentExplanationToMemoryQueryAnswer(explanation),
    shortAnswer: explanation.shortAnswer,
    nextStep: explanation.nextSteps[0] ?? explanation.recommendation,
  };
}

function answerMissingProofs(): MemoryQueryAnswer | null {
  const missing = getProofMemories().filter((item) => item.status === 'missing');
  if (missing.length === 0) return null;

  const labels = missing.map((item) => PROOF_LABELS[item.proofType] ?? item.proofType);
  return {
    shortAnswer: `${missing.length} Nachweis${missing.length === 1 ? '' : 'e'} fehlt${missing.length === 1 ? '' : 'en'}: ${labels.join(', ')}.`,
    source: 'Firmen-Gedächtnis: Nachweisstatus',
    digitalLocation: 'Fehlende Nachweise sind noch nicht digital abgelegt.',
    paperLocation: 'Kein Papierordner – Nachweis fehlt.',
    register: '—',
    status: 'Fehlend',
    nextStep: 'Fehlende Nachweise beschaffen und archivieren.',
  };
}

function answerExpiringProofs(todayIso: string): MemoryQueryAnswer | null {
  const expiring = getProofMemories().filter(
    (item) => computeProofStatus(item.validUntil, todayIso) === 'expiring',
  );
  if (expiring.length === 0) return null;

  const labels = expiring.map((item) => {
    const label = PROOF_LABELS[item.proofType] ?? item.proofType;
    return `${label} (${item.validUntil?.slice(0, 10) ?? '?'})`;
  });

  return {
    shortAnswer: `${expiring.length} Nachweis${expiring.length === 1 ? '' : 'e'} laufen bald ab.`,
    source: 'Firmen-Gedächtnis: Nachweisstatus',
    digitalLocation: 'Betroffene Nachweise im Dokumentarchiv prüfen.',
    paperLocation: 'Originalnachweise im Papierordner mitführen.',
    register: '—',
    status: 'Läuft bald ab',
    nextStep: 'Erneuerung anstoßen: ' + labels.join('; '),
  };
}

function answerFinanzamtLetters(): MemoryQueryAnswer | null {
  const memories = findFinanzamtMemories();
  if (memories.length === 0) return null;

  const titles = memories.map((item) => item.title).slice(0, 5);
  const latest = memories[0]!;

  return {
    shortAnswer: `${memories.length} Schreiben vom Finanzamt im Gedächtnis: ${titles.join('; ')}.`,
    source: 'Firmen-Gedächtnis: Finanzamt-Bezug',
    digitalLocation: memoryDigitalLocation(latest),
    paperLocation: memoryPaperLocation(latest),
    register: memoryRegister(latest),
    status: latest.memoryStatus === 'understood' ? 'Archiviert' : 'Teilweise erfasst',
    nextStep: latest.nextAction ?? 'Schreiben prüfen und bei Frist reagieren.',
    uncertainty: memories.length > 5 ? 'Weitere Finanzamt-Schreiben vorhanden.' : undefined,
  };
}

function answerReplyStatus(): MemoryQueryAnswer | null {
  const documents = getAllDocuments().slice(0, 10);
  const statuses = documents
    .map((doc) => ({
      doc,
      status: getCommunicationReplyStatus({ type: 'document', id: doc.id }),
    }))
    .filter((item) => item.status !== 'no_reply_needed');

  if (statuses.length === 0) return null;

  const pending = statuses.find((item) => item.status === 'needs_reply');
  const answered = statuses.find((item) => item.status === 'answered');
  const target = pending ?? answered ?? statuses[0]!;
  const memory = getAllDocumentMemories().find((item) => item.documentId === target.doc.id);

  return {
    shortAnswer: pending
      ? `Für „${target.doc.title}“ ist noch eine Antwort offen.`
      : answered
        ? `„${target.doc.title}“ wurde als beantwortet markiert.`
        : `Kommunikationsstatus zu „${target.doc.title}“: ${REPLY_STATUS_LABELS[target.status]}.`,
    source: `Kommunikationsverlauf / Firmen-Gedächtnis: ${target.doc.title}`,
    digitalLocation: formatDigitalLocation(target.doc),
    paperLocation: formatPaperLocation(target.doc),
    register: memory ? memoryRegister(memory) : target.doc.paperFolder?.register ?? '—',
    status: REPLY_STATUS_LABELS[target.status] ?? target.status,
    nextStep: pending ? 'Antwort vorbereiten oder als erledigt markieren.' : 'Kein weiterer Schritt nötig.',
    uncertainty: statuses.length > 1 ? 'Mehrere Dokumente mit Kommunikationsstatus vorhanden.' : undefined,
  };
}

export function answerMemoryQuestion(
  intent: MemoryQueryIntent,
  question: string,
  todayIso: string = getTodayIso(),
): MemoryQueryAnswer | null {
  switch (intent) {
    case 'freistellung_location':
      return answerFreistellungLocation();
    case 'freistellung_explanation':
      return answerFreistellungExplanation();
    case 'document_explanation':
      return answerDocumentExplanation(question);
    case 'action_required':
      return answerActionRequired(question);
    case 'paper_filing':
      return answerPaperFiling(question);
    case 'original_location':
      return answerOriginalLocation(question);
    case 'physical_filed_status':
      return answerPhysicalFiledStatus(question);
    case 'which_register':
      return answerWhichRegister(question);
    case 'which_folder':
      return answerWhichFolder(question);
    case 'expiry':
      return answerExpiry(todayIso);
    case 'bg_bau_content':
      return answerBgBauContent();
    case 'missing_proofs':
      return answerMissingProofs();
    case 'expiring_proofs':
      return answerExpiringProofs(todayIso);
    case 'finanzamt_letters':
      return answerFinanzamtLetters();
    case 'reply_status':
      return answerReplyStatus();
    default:
      return null;
  }
}

export function tryMemoryQueryAnswer(
  question: string,
  todayIso: string = getTodayIso(),
): MemoryQueryAnswer | null {
  const intent = detectMemoryQueryIntent(question);
  if (!intent) return null;
  return answerMemoryQuestion(intent, question, todayIso);
}

export function memoryQueryAnswerToAssistantAnswer(
  answer: MemoryQueryAnswer,
  title = 'Firmen-Gedächtnis',
): AssistantAnswer {
  const bullets = [
    `Quelle: ${answer.source}`,
    `Digital: ${answer.digitalLocation}`,
    `Papier: ${answer.paperLocation}`,
    `Register: ${answer.register}`,
    `Status: ${answer.status}`,
    `Nächster Schritt: ${answer.nextStep}`,
  ];
  if (answer.uncertainty) {
    bullets.push(`Unsicherheit: ${answer.uncertainty}`);
  }

  const actions: AssistantAction[] = [];
  const docMatch = answer.source.match(/Firmen-Gedächtnis: (.+)$/);
  if (docMatch) {
    const memory = getAllDocumentMemories().find((item) => item.title === docMatch[1]);
    if (memory?.documentId) {
      actions.push({
        id: memory.documentId,
        label: 'Dokument öffnen',
        route: `/dokumente/${memory.documentId}`,
      });
    }
  }

  return {
    title,
    summary: answer.shortAnswer,
    bullets,
    actions,
  };
}
