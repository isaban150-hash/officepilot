import type { AssistantAction, AssistantAnswer } from '../../types/models';
import type { MemoryQueryAnswer } from '../../types/memory';
import { getCommunicationReplyStatus } from '../communicationHistoryService';
import { getAllDocuments } from '../documentService';
import { formatPaperFilingInstruction } from '../paperFolderService';
import {
  computeProofStatus,
  getAllDocumentMemories,
  getProofMemories,
} from '../officePilotMemoryService';
import { getTodayIso } from '../taskNormalize';
import { getAuthorityLabel } from './memoryAuthorityMapping';
import { formatDigitalLocation, formatPaperLocation } from './documentSummaryService';

export type MemoryQueryIntent =
  | 'freistellung_location'
  | 'paper_filing'
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

  if (/wo liegt.*freistellung|freistellung.*(liegt|ablage|speicher|archiv)/.test(q)) {
    return 'freistellung_location';
  }
  if (/wo muss ich.*(abheften|ablegen)|original abheften|papierordner/.test(q)) {
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

function memoryPaperLocation(memory: ReturnType<typeof getAllDocumentMemories>[number]): string {
  if (!memory.paperFolder?.folderId && !memory.paperFolder?.label) {
    return 'Kein Papierordner hinterlegt – bitte Ablage prüfen.';
  }
  return formatPaperFilingInstruction(memory.paperFolder);
}

function memoryDigitalLocation(memory: ReturnType<typeof getAllDocumentMemories>[number]): string {
  const name = memory.digitalFolder?.name?.trim();
  if (!memory.digitalFolder?.path) return 'Kein digitaler Speicherort hinterlegt.';
  return name ? `${name} (${memory.digitalFolder.path})` : memory.digitalFolder.path;
}

function answerFreistellungLocation(): MemoryQueryAnswer | null {
  const memories = findFreistellungMemories();
  if (memories.length === 0) return null;

  const memory = memories[0]!;
  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const digital = doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory);
  const paper = doc ? formatPaperLocation(doc) : memoryPaperLocation(memory);
  const status = memory.validUntil
    ? `Gültig bis ${memory.validUntil.slice(0, 10)}`
    : 'Gültigkeit unbekannt';

  return {
    shortAnswer:
      memories.length === 1
        ? `Ihre Freistellungsbescheinigung liegt digital unter ${digital}.`
        : `${memories.length} Freistellungsbescheinigungen im Firmen-Gedächtnis.`,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: digital,
    paperLocation: paper,
    status,
    nextStep: memory.nextAction ?? memory.summary?.nextAction ?? 'Gültigkeit regelmäßig prüfen.',
    uncertainty: memories.length > 1 ? 'Mehrere Freistellungen gefunden – neueste zuerst genannt.' : undefined,
  };
}

function answerPaperFiling(question: string): MemoryQueryAnswer | null {
  const q = normalizeQuestion(question);
  const memories = getAllDocumentMemories();
  if (memories.length === 0) return null;

  let memory = memories[0]!;
  if (/freistellung/.test(q)) {
    memory = findFreistellungMemories()[0] ?? memory;
  }

  const doc = getAllDocuments().find((item) => item.id === memory.documentId);
  const paper = doc ? formatPaperLocation(doc) : memoryPaperLocation(memory);

  return {
    shortAnswer: paper,
    source: `Firmen-Gedächtnis: ${memory.title}`,
    digitalLocation: doc ? formatDigitalLocation(doc) : memoryDigitalLocation(memory),
    paperLocation: paper,
    status: memory.memoryStatus === 'understood' ? 'Verstanden und abgelegt' : 'Teilweise verstanden',
    nextStep: 'Original im Papierordner abheften und digitalen Pfad beibehalten.',
    uncertainty: !doc?.paperFolder?.folderId ? 'Papierordner nicht vollständig hinterlegt.' : undefined,
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
    status:
      status === 'expired'
        ? 'Abgelaufen'
        : status === 'expiring'
          ? 'Läuft bald ab'
          : 'Gültig',
    nextStep: memory?.nextAction ?? 'Erneuerung rechtzeitig einplanen.',
  };
}

function answerBgBauContent(): MemoryQueryAnswer | null {
  const memories = findBgBauMemories();
  if (memories.length === 0) return null;

  const memory = memories[0]!;
  const summary = memory.summary;
  const topic = summary?.topic ?? memory.topic ?? 'BG BAU Schreiben';
  const action = summary?.nextAction ?? memory.nextAction ?? 'Nachweis prüfen und archivieren.';

  return {
    shortAnswer: summary?.shortSummary ?? `${topic}. ${action}`,
    source: `Firmen-Gedächtnis: ${memory.title} (${getAuthorityLabel('bg_bau')})`,
    digitalLocation: memoryDigitalLocation(memory),
    paperLocation: memoryPaperLocation(memory),
    status: memory.validUntil
      ? `Gültig bis ${memory.validUntil.slice(0, 10)}`
      : 'Inhalt aus Archiv – Frist prüfen',
    nextStep: action,
    uncertainty: summary?.sourceConfidence === 'low' ? 'Inhalt nur teilweise erkannt.' : undefined,
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

  return {
    shortAnswer: pending
      ? `Für „${target.doc.title}“ ist noch eine Antwort offen.`
      : answered
        ? `„${target.doc.title}“ wurde als beantwortet markiert.`
        : `Kommunikationsstatus zu „${target.doc.title}“: ${REPLY_STATUS_LABELS[target.status]}.`,
    source: `Kommunikationsverlauf / Firmen-Gedächtnis: ${target.doc.title}`,
    digitalLocation: formatDigitalLocation(target.doc),
    paperLocation: formatPaperLocation(target.doc),
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
    case 'paper_filing':
      return answerPaperFiling(question);
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
