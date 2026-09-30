import type {
  OfficeSearchFilter,
  OfficeSearchOptions,
  SearchResult,
  SearchResultGroup,
  SearchResultType,
} from '../types/officeSearch';
import type { AssistantAction, AssistantAnswer } from '../types/models';
import { getCommunicationEvents } from './communicationHistoryService';
import { isGeneratedOutgoingInvoiceDocument, searchDocuments } from './documentService';
import { getCustomerStoreSnapshot } from './customerStoreService';
import { findInvoiceById } from './invoice/invoiceRegistryService';
import { isEntitySyncActive } from './sync/syncMetaService';
import type { EmailMessage } from '../types/emailMessage';
import { formatDisplayDatePadded, formatDisplayDateTime } from '../utils/displayFormat';
import { getOpenDocumentLifecycleItems } from './documentLifecycleService';
import { searchExpenses } from './expenseService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { filterActiveItems, getInboxItems } from './inboxService';
import {
  getAllInvoiceOverview,
  searchInvoiceOverview,
  type InvoiceOverviewItem,
} from './invoiceOverviewService';
import { buildInvoiceDetailPath, buildInvoiceReachPath } from './invoiceNavigation';
import { getMailImports } from './mailImportService';
import {
  getAllDocumentMemories,
  getDocumentMemoryByDocumentId,
  getPaperRegisterEntries,
  getProofMemories,
} from './officePilotMemoryService';
import {
  getAllPaperFolders,
  getPhysicalFilingStatusLabel,
} from './paperFolderService';
import { getAllTasksFromStore } from './taskStore';
import { getTodayIso, isTaskOpen } from './taskNormalize';
import { getAllVorgaenge } from './vorgangService';
import { resolveDocumentLifecycle } from './documentLifecycleService';
import { getCachedSetup } from './persistenceService';
import {
  buildSummaryForCompanyDocument,
  buildSummaryForInboxItem,
  createPresentationTranslate,
  presentDocumentSummaryForSnippet,
} from './documentSummaryPresentation';

const TYPE_BASE_SCORE: Record<SearchResultType, number> = {
  document: 70,
  inbox: 65,
  mail: 60,
  proof: 58,
  invoice: 55,
  vorgang: 55,
  expense: 50,
  communication: 45,
  task: 40,
  customer: 60,
  email: 60,
};

const TYPE_ICON: Record<SearchResultType, string> = {
  document: '📄',
  inbox: '📥',
  mail: '✉️',
  proof: '📋',
  invoice: '🧾',
  expense: '💶',
  vorgang: '🏗️',
  task: '☑️',
  communication: '💬',
  customer: '👤',
  email: '✉️',
};

const TYPE_SOURCE_LABEL: Record<SearchResultType, string> = {
  document: 'Dokument',
  inbox: 'Eingang',
  mail: 'E-Mail',
  proof: 'Nachweis',
  invoice: 'Rechnung',
  expense: 'Ausgabe',
  vorgang: 'Auftrag',
  task: 'Aufgabe',
  communication: 'Kommunikation',
  customer: 'Kunde',
  email: 'E-Mail',
};

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — Statuswerte in Klartext.
 *
 * Die Rohwerte (`ueberfaellig`, `in_bearbeitung`, `missing` …) bleiben in
 * `status`, weil Filter sie prüfen. Angezeigt wird nur, was hier steht; ein
 * unbekannter Wert wird nicht angezeigt statt roh durchgereicht.
 */
const STATUS_LABELS: Record<string, string> = {
  offen: 'Offen',
  teilbezahlt: 'Teilweise bezahlt',
  bezahlt: 'Bezahlt',
  ueberbezahlt: 'Überzahlt',
  ueberfaellig: 'Überfällig',
  storniert: 'Storniert',
  gutschrift: 'Gutschrift',
  neu: 'Neu',
  eingegangen: 'Eingegangen',
  in_pruefung: 'In Prüfung',
  in_verhandlung: 'In Verhandlung',
  beauftragt: 'Beauftragt',
  in_bearbeitung: 'In Bearbeitung',
  wartet: 'Wartet',
  abgeschlossen: 'Abgeschlossen',
  geprueft: 'Geprüft',
  abgelegt: 'Abgelegt',
  spaeter_klaeren: 'Später klären',
  niedrig: 'Priorität niedrig',
  mittel: 'Priorität mittel',
  hoch: 'Priorität hoch',
  kritisch: 'Priorität kritisch',
  valid: 'Gültig',
  expiring: 'Läuft bald ab',
  expired: 'Abgelaufen',
  missing: 'Fehlt',
  pending: 'Wartet',
  importing: 'Wird übernommen',
  processed: 'Übernommen',
  failed: 'Fehlgeschlagen',
};

const TECHNICAL_STATUS = /^[a-z0-9]+(?:_[a-z0-9]+)+$|^[a-z]+$/;

export function searchStatusLabel(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const known = STATUS_LABELS[status];
  if (known) return known;
  // Bereits lesbarer Text (z. B. „Antwort offen") bleibt; Rohwerte nicht.
  return TECHNICAL_STATUS.test(status) ? undefined : status;
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — deutsche Daten in Trefferzeilen.
 * Nur echte Kalenderdaten (JJJJ-MM-TT); Rechnungsnummern wie „2026-0018"
 * haben ein anderes Muster und bleiben unberührt.
 */
export function germanizeIsoDates(text: string): string {
  return text.replace(
    /\b(\d{4})-(\d{2})-(\d{2})(T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g,
    (match: string, year: string, month: string, day: string, time?: string) =>
      // Mit Uhrzeit: in Ortszeit umrechnen, sonst kippt der Tag um Mitternacht.
      time ? formatDisplayDatePadded(match) : `${day}.${month}.${year}`,
  );
}

function presentResult(result: SearchResult): SearchResult {
  return {
    ...result,
    title: germanizeIsoDates(result.title),
    subtitle: germanizeIsoDates(result.subtitle),
    snippet: germanizeIsoDates(result.snippet),
    statusLabel: result.statusLabel ?? searchStatusLabel(result.status),
  };
}

const PROOF_LABELS: Record<string, string> = {
  freistellungsbescheinigung: 'Freistellungsbescheinigung',
  bg_bau: 'BG BAU',
  soka_bau: 'SOKA BAU',
  betriebshaftpflicht: 'Betriebshaftpflicht',
};

const RULE_TERM_EXPANSIONS: Record<string, string[]> = {
  freistellung: ['freistellungsbescheinigung', '§48b'],
  'bg bau': ['bg bau', 'berufsgenossenschaft'],
  bg: ['bg bau', 'bg_bau'],
  finanzamt: ['finanzamt', 'steuer'],
  aok: ['aok', 'krankenkasse'],
  tk: ['techniker krankenkasse', 'tk'],
  barmer: ['barmer'],
  ikk: ['ikk', 'innungskrankenkasse'],
  soka: ['soka', 'soka bau'],
  werkvertrag: ['werkvertrag', 'subunternehmer'],
  mahnung: ['mahnung', 'zahlungserinnerung'],
  versicherung: ['versicherung', 'haftpflicht'],
  rechnung: ['rechnung', 'invoice'],
  auftrag: ['auftrag', 'vorgang'],
  nachweise: ['nachweis', 'proof', 'freistellung', 'bg bau'],
  'offene briefe': ['brief', 'behoerde', 'finanzamt'],
  'antwort offen': ['antwort', 'needs_reply'],
  'papier fehlt': ['original', 'abheften', 'papier'],
  'nicht abgeheftet': ['original', 'abheften', 'papier'],
  'nachweis fehlt': ['nachweis', 'missing', 'proof'],
  abgelaufen: ['expired', 'abgelaufen', 'ablauf'],
  heute: ['heute', 'frist'],
};

export function normalizeSearchQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^\wäöüß0-9\s/-]/gi, ' ')
    .replace(/\s+/g, ' ');
}

export function expandSearchTerms(query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return [];

  const terms = new Set<string>(normalized.split(' ').filter(Boolean));
  terms.add(normalized);

  for (const [key, expansions] of Object.entries(RULE_TERM_EXPANSIONS)) {
    if (normalized.includes(key)) {
      expansions.forEach((term) => terms.add(term));
    }
  }

  return [...terms];
}

function buildHaystack(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function createSnippet(text: string, query: string, maxLength = 120): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const index = lower.indexOf(query);
  if (index === -1) {
    return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
  }
  const start = Math.max(0, index - 30);
  const end = Math.min(trimmed.length, index + query.length + 60);
  return `${start > 0 ? '…' : ''}${trimmed.slice(start, end)}${end < trimmed.length ? '…' : ''}`;
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — Relevanz.
 *
 * Bisher zählte der **erste** passende Begriff; weil Einzelwörter vor der
 * ganzen Phrase stehen, bekam „AZ Testbau" für „Resume Testbau" dieselbe
 * Bewertung wie „Resume Testbau GmbH". Jetzt zählt der beste Begriff, und
 * zusätzlich:
 *
 *   * alle Wörter der Anfrage vorhanden  → +10
 *   * die ganze Phrase vorhanden          → +20
 *   * Hauptfeld (Name/Titel/Nummer) gleich der Anfrage → +40,
 *     beginnt damit → +25, enthält sie → +15
 *
 * Schwache Teiltreffer bleiben sichtbar, stehen aber hinten.
 */
function matchTerms(
  haystack: string,
  terms: string[],
  query = '',
  primary: Array<string | null | undefined> = [],
): { matched: boolean; matchedField: string; boost: number } {
  if (!haystack) return { matched: false, matchedField: '', boost: 0 };

  let best = { matched: false, matchedField: '', boost: 0 };
  for (const term of terms) {
    if (!term) continue;
    const candidate =
      haystack === term
        ? { matched: true, matchedField: 'Exakter Treffer', boost: 40 }
        : haystack.startsWith(term)
          ? { matched: true, matchedField: 'Titel/Nummer', boost: 30 }
          : haystack.includes(term)
            ? { matched: true, matchedField: 'Inhalt', boost: 15 }
            : null;
    if (candidate && candidate.boost > best.boost) best = candidate;
  }
  if (!best.matched || !query) return best;

  let bonus = 0;
  const words = query.split(' ').filter(Boolean);
  if (words.length > 1) {
    if (words.every((word) => haystack.includes(word))) bonus += 10;
    if (haystack.includes(query)) bonus += 20;
  }
  let primaryBonus = 0;
  for (const field of primary) {
    const value = normalizeSearchQuery(field ?? '');
    if (!value) continue;
    if (value === query) primaryBonus = Math.max(primaryBonus, 40);
    else if (value.startsWith(query)) primaryBonus = Math.max(primaryBonus, 25);
    else if (value.includes(query)) primaryBonus = Math.max(primaryBonus, 15);
  }
  return {
    ...best,
    matchedField: primaryBonus >= 25 ? 'Name/Titel' : best.matchedField,
    boost: best.boost + bonus + primaryBonus,
  };
}

function resultKey(result: SearchResult): string {
  return `${result.type}:${result.route}`;
}

function invoiceRoute(entry: InvoiceOverviewItem): string {
  // 01B2c — ohne Auftrag führt der Weg in die Übersicht, nicht ins Leere.
  return buildInvoiceReachPath(entry.vorgangId, entry.invoice.id);
}

function taskRoute(task: {
  linkedVorgangId?: string;
  linkedInvoiceId?: string;
  linkedDocumentId?: string;
  linkedInboxId?: string;
}): string {
  if (task.linkedVorgangId && task.linkedInvoiceId) {
    return buildInvoiceDetailPath(task.linkedVorgangId, task.linkedInvoiceId);
  }
  if (task.linkedDocumentId) return `/dokumente/${task.linkedDocumentId}`;
  if (task.linkedInboxId) return `/ablage/${task.linkedInboxId}`;
  if (task.linkedVorgangId) return `/vorgaenge/${task.linkedVorgangId}`;
  return '/aufgaben';
}

function pushResult(results: SearchResult[], candidate: SearchResult): void {
  const key = resultKey(candidate);
  const existingIndex = results.findIndex((item) => resultKey(item) === key);
  if (existingIndex === -1) {
    results.push(candidate);
    return;
  }
  if (candidate.score > results[existingIndex]!.score) {
    results[existingIndex] = candidate;
  }
}

function includesType(filter: OfficeSearchFilter | undefined, type: SearchResultType): boolean {
  if (!filter?.types?.length) return true;
  return filter.types.includes(type);
}

function collectDocumentResults(query: string, terms: string[], todayIso: string): SearchResult[] {
  const results: SearchResult[] = [];
  const translate = createPresentationTranslate(getCachedSetup()?.language);

  for (const doc of searchDocuments(query, 'all')) {
    const memory = getDocumentMemoryByDocumentId(doc.id);
    const lifecycle = resolveDocumentLifecycle({ documentId: doc.id }, todayIso);
    const summary = buildSummaryForCompanyDocument(doc, { translate });
    const presentation = presentDocumentSummaryForSnippet(summary, translate);
    const haystack = buildHaystack([
      doc.title,
      doc.issuer,
      doc.recognizedText,
      doc.linkedCompany,
      doc.linkedVorgang?.vorgangTitle,
      doc.digitalFolder.path,
      doc.digitalFolder.name,
      doc.paperFolder?.register,
      doc.paperFolder?.label,
      ...doc.tags,
      presentation.title,
      presentation.subtitle,
      presentation.snippet,
      memory?.summary?.shortSummary,
      memory?.summary?.topic,
      memory?.mailSubject,
      memory?.mailFrom,
      memory?.letterExplanation?.shortExplanation,
    ]);

    const match = matchTerms(haystack, terms, query, [doc.title, presentation.title]);
    if (!match.matched && query) continue;

    let score = TYPE_BASE_SCORE.document + match.boost;
    if (memory?.summary) score += 10;
    if (lifecycle?.openReasons.includes('reply_open')) score += 25;
    if (lifecycle?.openReasons.includes('deadline_open')) score += 25;
    if (lifecycle?.openReasons.includes('proof_missing')) score += 25;
    if (lifecycle?.openReasons.includes('file_original')) score += 20;

    pushResult(results, {
      id: `search-doc-${doc.id}`,
      type: 'document',
      title: generatedInvoiceDocumentTitle(doc, presentation.title),
      subtitle: presentation.subtitle || TYPE_SOURCE_LABEL.document,
      matchedField: match.matchedField || 'Dokument',
      snippet: createSnippet(presentation.snippet, query || terms[0] || ''),
      score,
      route: `/dokumente/${doc.id}`,
      icon: TYPE_ICON.document,
      status: lifecycle?.openItems[0],
      source: memory?.source === 'email' ? 'E-Mail-Dokument' : TYPE_SOURCE_LABEL.document,
    });
  }

  return results;
}

function collectMemoryResults(query: string, terms: string[], todayIso: string): SearchResult[] {
  const results: SearchResult[] = [];

  for (const memory of getAllDocumentMemories()) {
    const haystack = buildHaystack([
      memory.title,
      memory.issuer,
      memory.classifiedKind,
      memory.summary?.shortSummary,
      memory.summary?.topic,
      memory.summary?.nextAction,
      memory.topic,
      memory.nextAction,
      memory.mailSubject,
      memory.mailFrom,
      memory.paperFolder.register,
      memory.paperFolder.label,
      memory.digitalFolder.path,
      memory.digitalFolder.name,
      memory.letterExplanation?.shortExplanation,
      ...(memory.requiredDocuments ?? []),
    ]);

    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    const lifecycle = resolveDocumentLifecycle({ documentId: memory.documentId }, todayIso);
    pushResult(results, {
      id: `search-mem-${memory.id}`,
      type: 'document',
      title: memory.title,
      subtitle: memory.summary?.documentKindLabel ?? memory.issuer,
      matchedField: match.matchedField || 'Gedächtnis',
      snippet: createSnippet(memory.summary?.shortSummary ?? memory.title, query || terms[0] || ''),
      score: TYPE_BASE_SCORE.document + match.boost + 5,
      route: `/dokumente/${memory.documentId}`,
      icon: TYPE_ICON.document,
      status: lifecycle?.openItems[0],
      source: 'DocumentMemory',
    });
  }

  return results;
}

function collectInboxResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];
  const translate = createPresentationTranslate(getCachedSetup()?.language);

  for (const item of filterActiveItems(getInboxItems())) {
    const extracted = getInboxExtractedDocumentText(item);
    const summary = buildSummaryForInboxItem(item, { translate });
    const presentation = presentDocumentSummaryForSnippet(summary, translate);
    const haystack = buildHaystack([
      item.title,
      item.sender,
      item.classifiedKind,
      extracted,
      item.officePilotSuggestion,
      item.paperFiling.register,
      item.digitalFolder.path,
      item.vorgangTitle,
      presentation.title,
      presentation.subtitle,
      presentation.snippet,
      ...Object.values(item.recognizedData),
    ]);

    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    pushResult(results, {
      id: `search-inbox-${item.id}`,
      type: 'inbox',
      title: presentation.title,
      subtitle: presentation.subtitle || TYPE_SOURCE_LABEL.inbox,
      matchedField: match.matchedField || 'Eingang',
      snippet: createSnippet(presentation.snippet, query || terms[0] || ''),
      score: TYPE_BASE_SCORE.inbox + match.boost,
      route: `/ablage/${item.id}`,
      icon: TYPE_ICON.inbox,
      status: item.status,
      source: item.importSource === 'email' ? 'E-Mail-Eingang' : TYPE_SOURCE_LABEL.inbox,
    });
  }

  return results;
}

function collectMailResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const mail of getMailImports()) {
    const haystack = buildHaystack([
      mail.subject,
      mail.from,
      mail.bodyText,
      ...mail.attachments.map((item) => item.fileName),
    ]);

    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    const inboxId = mail.linkedInboxIds[0];
    pushResult(results, {
      id: `search-mail-${mail.id}`,
      type: 'mail',
      title: mail.subject,
      subtitle: mail.from,
      matchedField: match.matchedField || 'E-Mail',
      snippet: createSnippet(mail.bodyText || mail.subject, query || terms[0] || ''),
      score: TYPE_BASE_SCORE.mail + match.boost,
      route: inboxId ? `/ablage/${inboxId}` : '/mail-import',
      icon: TYPE_ICON.mail,
      status: mail.status,
      source: TYPE_SOURCE_LABEL.mail,
    });
  }

  return results;
}

function collectProofResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const proof of getProofMemories()) {
    const label = PROOF_LABELS[proof.proofType] ?? proof.proofType;
    const haystack = buildHaystack([label, proof.proofType, proof.status, proof.validUntil ?? '']);

    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    let score = TYPE_BASE_SCORE.proof + match.boost;
    if (proof.status === 'missing') score += 30;
    if (proof.status === 'expired') score += 25;

    pushResult(results, {
      id: `search-proof-${proof.id}`,
      type: 'proof',
      title: label,
      subtitle: proof.status === 'missing' ? 'Nachweis fehlt' : `Status: ${proof.status}`,
      matchedField: match.matchedField || 'Nachweis',
      snippet: createSnippet(label, query || terms[0] || ''),
      score,
      route: proof.documentId
        ? `/dokumente/${proof.documentId}`
        : proof.requiredByVorgangIds[0]
          ? `/vorgaenge/${proof.requiredByVorgangIds[0]}`
          : '/dokumente',
      icon: TYPE_ICON.proof,
      status: proof.status,
      source: 'ProofMemory',
    });
  }

  return results;
}

function collectInvoiceResults(query: string, terms: string[], todayIso: string): SearchResult[] {
  const results: SearchResult[] = [];
  const items = query
    ? searchInvoiceOverview(getAllInvoiceOverview(todayIso), query)
    : getAllInvoiceOverview(todayIso);

  for (const item of items) {
    const haystack = buildHaystack([
      item.invoice.number,
      item.customer,
      item.vorgangTitle,
      item.baustelle,
      String(item.paymentSummary.openAmount),
      item.paymentSummary.status,
    ]);

    const match = matchTerms(haystack, terms, query, [item.invoice.number, item.customer]);
    if (!match.matched && query) continue;

    let score = TYPE_BASE_SCORE.invoice + match.boost;
    if (item.paymentSummary.status === 'ueberfaellig') score += 30;

    pushResult(results, {
      id: `search-invoice-${item.invoice.id}`,
      type: 'invoice',
      title: `Rechnung ${item.invoice.number}`,
      subtitle: `${item.customer} – ${item.vorgangTitle}`,
      matchedField: match.matchedField || 'Rechnung',
      snippet: createSnippet(`${item.customer} ${item.baustelle ?? ''}`, query || terms[0] || ''),
      score,
      route: invoiceRoute(item),
      icon: TYPE_ICON.invoice,
      status: item.paymentSummary.status,
      source: TYPE_SOURCE_LABEL.invoice,
    });
  }

  return results;
}

function collectExpenseResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const expense of searchExpenses(query, 'all')) {
    const haystack = buildHaystack([
      expense.title,
      expense.supplierName,
      expense.invoiceNumber,
      String(expense.grossAmount),
    ]);
    const match = matchTerms(haystack, terms, query, [expense.title, expense.supplierName, expense.invoiceNumber]);
    if (!match.matched && query) continue;

    pushResult(results, {
      id: `search-expense-${expense.id}`,
      type: 'expense',
      title: expense.title,
      subtitle: expense.supplierName,
      matchedField: match.matchedField || 'Ausgabe',
      snippet: createSnippet(`${expense.supplierName} ${expense.invoiceNumber ?? ''}`, query || terms[0] || ''),
      score: TYPE_BASE_SCORE.expense + match.boost,
      route: `/ausgaben/${expense.id}`,
      icon: TYPE_ICON.expense,
      status: expense.paymentStatus,
      source: TYPE_SOURCE_LABEL.expense,
    });
  }

  return results;
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — die eigene Ausgangsrechnung im Archiv hiess
 * in der Trefferliste nur „Ausgangsrechnung"; zehn davon waren nicht zu
 * unterscheiden. Die Rechnungsnummer kommt aus der verknüpften Rechnung.
 */
function generatedInvoiceDocumentTitle(
  doc: Parameters<typeof isGeneratedOutgoingInvoiceDocument>[0],
  title: string,
): string {
  if (!isGeneratedOutgoingInvoiceDocument(doc)) return title;
  const number = findInvoiceById(doc.linkedInvoiceId!.trim())?.number?.trim();
  if (!number || title.includes(number)) return title;
  return `${title} ${number}`;
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — Kunden als eigener Treffer.
 *
 * Nur aktive Kunden aus dem eigenen, bereits workspace-gebundenen Bestand.
 * Angezeigt werden Name und Ort — keine Kennung.
 */
function collectCustomerResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];
  if (!query) return results;

  for (const customer of getCustomerStoreSnapshot()) {
    if (!isEntitySyncActive(customer)) continue;
    const name = customer.name?.trim();
    if (!name) continue;
    const place = [customer.zip, customer.city].filter((part) => part?.trim()).join(' ');
    const haystack = buildHaystack([
      name,
      customer.contactPerson,
      customer.street,
      place,
      customer.email,
    ]);
    const match = matchTerms(haystack, terms, query, [name, customer.contactPerson]);
    if (!match.matched) continue;

    pushResult(results, {
      id: `search-customer-${customer.id}`,
      type: 'customer',
      title: name,
      subtitle: [customer.contactPerson?.trim(), place].filter(Boolean).join(' · ') || TYPE_SOURCE_LABEL.customer,
      matchedField: match.matchedField || 'Kunde',
      snippet: [customer.street?.trim(), place].filter(Boolean).join(', '),
      score: TYPE_BASE_SCORE.customer + match.boost,
      route: `/kunden/customer/${encodeURIComponent(customer.id)}`,
      icon: TYPE_ICON.customer,
      source: TYPE_SOURCE_LABEL.customer,
    });
  }

  return results;
}

/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — E-Mails aus der Cloud als Treffer.
 *
 * Rein: bekommt die bereits workspace-gebunden geladenen Nachrichten
 * (`list_workspace_*_email_messages` prüft die Mitgliedschaft serverseitig)
 * und bewertet sie wie jeden anderen Treffer. Durchsucht werden Betreff,
 * Absender/Empfänger und Text; angezeigt werden nur Betreff, Absender und
 * Datum — kein Nachrichtentext, keine Kennung.
 */
export function buildEmailSearchResults(messages: EmailMessage[], rawQuery: string): SearchResult[] {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return [];
  const terms = expandSearchTerms(query);
  const results: SearchResult[] = [];

  for (const message of messages) {
    const inbound = message.direction === 'inbound';
    const subject = message.subject?.trim() || '(ohne Betreff)';
    const counterpart = inbound
      ? message.fromName?.trim() || message.fromAddress?.trim() || ''
      : message.to.join(', ');
    const haystack = buildHaystack([
      message.subject,
      message.fromName,
      message.fromAddress,
      ...message.to,
      // Adressen auch in der Form der normalisierten Anfrage („name example de").
      normalizeSearchQuery(message.fromAddress ?? ''),
      ...message.to.map(normalizeSearchQuery),
      message.bodyText,
    ]);
    const match = matchTerms(haystack, terms, query, [message.subject]);
    if (!match.matched) continue;
    const bodyOnly = !buildHaystack([message.subject, message.fromName, message.fromAddress, ...message.to]).includes(
      query,
    );
    const when = inbound ? message.receivedAt ?? message.createdAt : message.createdAt;

    results.push(
      presentResult({
        id: `search-email-${message.id}`,
        type: 'email',
        title: subject,
        subtitle: [inbound ? `Von ${counterpart}` : `An ${counterpart}`, when ? formatDisplayDateTime(when) : '']
          .filter((part) => part && part.trim() !== 'Von' && part.trim() !== 'An')
          .join(' · '),
        matchedField: bodyOnly && match.matchedField !== 'Name/Titel' ? 'Text der E-Mail' : match.matchedField,
        snippet: inbound ? 'Eingegangene E-Mail' : 'Gesendete E-Mail',
        score: TYPE_BASE_SCORE.email + match.boost,
        route: inbound ? `/kommunikation/eingang/${message.id}` : `/kommunikation/email/${message.id}`,
        icon: TYPE_ICON.email,
        source: TYPE_SOURCE_LABEL.email,
      }),
    );
  }

  return rankSearchResults(results);
}

/** Lokale und Cloud-Treffer zu einer Liste, nach Relevanz, ohne Doppelte. */
export function mergeSearchResults(
  local: SearchResult[],
  remote: SearchResult[],
  limit: number,
): SearchResult[] {
  const merged: SearchResult[] = [];
  for (const result of [...local, ...remote]) pushResult(merged, result);
  return rankSearchResults(merged).slice(0, limit);
}

function collectVorgangResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const vorgang of getAllVorgaenge()) {
    // EINGANG-01C-2 — die Vorgangsnummer ist such- und sichtbar, wenn vergeben;
    // am Ende des Suchtexts, damit die bestehende Titel-Gewichtung gleich bleibt.
    const haystack = buildHaystack([vorgang.title, vorgang.customer, vorgang.baustelle, vorgang.status, vorgang.vorgangNumber]);
    const match = matchTerms(haystack, terms, query, [vorgang.title, vorgang.customer, vorgang.vorgangNumber]);
    if (!match.matched && query) continue;

    pushResult(results, {
      id: `search-vorgang-${vorgang.id}`,
      type: 'vorgang',
      title: vorgang.vorgangNumber ? `${vorgang.vorgangNumber} · ${vorgang.title}` : vorgang.title,
      subtitle: `${vorgang.customer}${vorgang.baustelle ? ` – ${vorgang.baustelle}` : ''}`,
      matchedField: match.matchedField || 'Auftrag',
      snippet: createSnippet(`${vorgang.customer} ${vorgang.baustelle ?? ''}`, query || terms[0] || ''),
      score: TYPE_BASE_SCORE.vorgang + match.boost,
      route: `/vorgaenge/${vorgang.id}`,
      icon: TYPE_ICON.vorgang,
      status: vorgang.status,
      source: TYPE_SOURCE_LABEL.vorgang,
    });
  }

  return results;
}

function collectTaskResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const task of getAllTasksFromStore()) {
    if (!isTaskOpen(task)) continue;
    const haystack = buildHaystack([task.title, task.description, task.category]);
    const match = matchTerms(haystack, terms, query, [task.title]);
    if (!match.matched && query) continue;

    pushResult(results, {
      id: `search-task-${task.id}`,
      type: 'task',
      title: task.title,
      subtitle: task.dueDate ? `Frist ${formatDisplayDatePadded(task.dueDate.slice(0, 10))}` : 'Offene Aufgabe',
      matchedField: match.matchedField || 'Aufgabe',
      snippet: createSnippet(task.description ?? task.title, query || terms[0] || ''),
      score: TYPE_BASE_SCORE.task + match.boost,
      route: taskRoute(task),
      icon: TYPE_ICON.task,
      status: task.priority,
      source: TYPE_SOURCE_LABEL.task,
    });
  }

  return results;
}

function collectCommunicationResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const event of getCommunicationEvents()) {
    const haystack = buildHaystack([event.type, event.resultExcerpt, event.userInputExcerpt]);
    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    const route =
      event.contextRef.type === 'document' && event.contextRef.id
        ? `/dokumente/${event.contextRef.id}`
        : event.contextRef.type === 'inbox' && event.contextRef.id
          ? `/ablage/${event.contextRef.id}`
          : '/kommunikation';

    pushResult(results, {
      id: `search-comm-${event.id}`,
      type: 'communication',
      title: event.resultExcerpt?.slice(0, 80) || 'Kommunikation',
      subtitle: event.type.replace(/_/g, ' '),
      matchedField: match.matchedField || 'Kommunikation',
      snippet: createSnippet(event.resultExcerpt ?? event.userInputExcerpt ?? '', query || terms[0] || ''),
      score: TYPE_BASE_SCORE.communication + match.boost,
      route,
      icon: TYPE_ICON.communication,
      status: event.status,
      source: TYPE_SOURCE_LABEL.communication,
    });
  }

  return results;
}

function collectPaperResults(query: string, terms: string[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const folder of getAllPaperFolders()) {
    const haystack = buildHaystack([folder.name, ...folder.registers]);
    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    pushResult(results, {
      id: `search-folder-${folder.id}`,
      type: 'document',
      title: folder.name,
      subtitle: 'Papierordner',
      matchedField: match.matchedField || 'Papierordner',
      snippet: folder.registers.join(', '),
      score: 35 + match.boost,
      route: '/papierarchiv',
      icon: '🗂️',
      source: 'Papierordner',
    });
  }

  for (const entry of getPaperRegisterEntries()) {
    const haystack = buildHaystack([entry.documentTitle, entry.register, entry.folderId]);
    const match = matchTerms(haystack, terms, query);
    if (!match.matched && query) continue;

    pushResult(results, {
      id: `search-register-${entry.id}`,
      type: 'document',
      title: entry.documentTitle,
      subtitle: `Register ${entry.register}`,
      matchedField: match.matchedField || 'Register',
      snippet: entry.register,
      score: 45 + match.boost,
      route: `/dokumente/${entry.documentId}`,
      icon: '🗂️',
      status: getPhysicalFilingStatusLabel(entry.physicalFiled, entry.filedAt).statusKey,
      source: 'Register',
    });
  }

  return results;
}

function collectLifecycleStatusResults(
  todayIso: string,
  reason?: 'reply_open' | 'file_original' | 'deadline_open' | 'proof_missing',
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const item of getOpenDocumentLifecycleItems(todayIso)) {
    if (reason && !item.openReasons.includes(reason)) continue;

    let score = 80;
    if (item.openReasons.includes('reply_open')) score += 25;
    if (item.openReasons.includes('file_original')) score += 25;
    if (item.openReasons.includes('deadline_open')) score += 25;
    if (item.openReasons.includes('proof_missing')) score += 25;

    pushResult(results, {
      id: `search-life-${item.documentId ?? item.inboxId}-${reason ?? 'open'}`,
      type: item.documentId ? 'document' : 'inbox',
      title: item.title,
      subtitle: item.openItems[0] ?? 'Offen',
      matchedField: 'Status',
      snippet: item.nextStep,
      score,
      route: item.route,
      icon: item.documentId ? TYPE_ICON.document : TYPE_ICON.inbox,
      status: item.openItems[0],
      source: 'Lebenszyklus',
    });
  }

  return results;
}

function detectStatusQuery(query: string): OfficeSearchFilter | null {
  const q = normalizeSearchQuery(query);
  if (!q) return null;

  const filter: OfficeSearchFilter = {};
  if (/antwort offen|offene briefe|beantworten/.test(q)) filter.replyOpen = true;
  if (/nachweis fehlt|nachweise fehlen|fehlende nachweise/.test(q)) filter.proofMissing = true;
  if (/frist offen|heute/.test(q)) filter.deadlineOpen = true;
  if (/papier fehlt|nicht abgeheftet|original fehlt|original noch/.test(q)) filter.paperMissing = true;
  if (/überfällig|abgelaufen/.test(q)) filter.overdue = true;

  return Object.keys(filter).length > 0 ? filter : null;
}

function applyFilters(results: SearchResult[], filter?: OfficeSearchFilter): SearchResult[] {
  if (!filter) return results;

  return results.filter((result) => {
    if (filter.types?.length && !filter.types.includes(result.type)) return false;
    if (filter.customer && !result.subtitle.toLowerCase().includes(filter.customer.toLowerCase())) {
      return false;
    }
    if (filter.replyOpen && result.status !== 'Antwort offen') return false;
    if (filter.proofMissing && result.status !== 'missing' && result.status !== 'Nachweis fehlt') {
      return false;
    }
    if (filter.paperMissing && result.status !== 'Original noch abheften') return false;
    if (filter.overdue && result.status !== 'ueberfaellig' && result.status !== 'expired') return false;
    if (filter.mailOnly && result.type !== 'mail') return false;
    if (filter.invoiceOnly && result.type !== 'invoice') return false;
    if (filter.taskOnly && result.type !== 'task') return false;
    return true;
  });
}

export function rankSearchResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'de'));
}

export function groupSearchResults(results: SearchResult[]): SearchResultGroup[] {
  const groups = new Map<SearchResultType, SearchResult[]>();
  for (const result of results) {
    const list = groups.get(result.type) ?? [];
    list.push(result);
    groups.set(result.type, list);
  }

  return [...groups.entries()].map(([type, items]) => ({
    type,
    label: TYPE_SOURCE_LABEL[type],
    items: rankSearchResults(items),
  }));
}

export function searchOffice(options: OfficeSearchOptions): SearchResult[] {
  const query = normalizeSearchQuery(options.query);
  const terms = expandSearchTerms(query);
  const todayIso = options.todayIso ?? getTodayIso();
  const filter = { ...options.filter, ...detectStatusQuery(query) };

  if (!query && !filter && !options.filter) return [];

  let results: SearchResult[] = [];

  if (includesType(filter, 'document')) {
    results.push(...collectDocumentResults(query, terms, todayIso));
    results.push(...collectMemoryResults(query, terms, todayIso));
    results.push(...collectPaperResults(query, terms));
  }
  if (includesType(filter, 'inbox')) results.push(...collectInboxResults(query, terms));
  if (includesType(filter, 'mail')) results.push(...collectMailResults(query, terms));
  if (includesType(filter, 'proof')) results.push(...collectProofResults(query, terms));
  if (includesType(filter, 'invoice')) results.push(...collectInvoiceResults(query, terms, todayIso));
  if (includesType(filter, 'expense')) results.push(...collectExpenseResults(query, terms));
  if (includesType(filter, 'customer')) results.push(...collectCustomerResults(query, terms));
  if (includesType(filter, 'vorgang')) results.push(...collectVorgangResults(query, terms));
  if (includesType(filter, 'task')) results.push(...collectTaskResults(query, terms));
  if (includesType(filter, 'communication')) results.push(...collectCommunicationResults(query, terms));

  if (filter?.replyOpen) results.push(...collectLifecycleStatusResults(todayIso, 'reply_open'));
  if (filter?.paperMissing) results.push(...collectLifecycleStatusResults(todayIso, 'file_original'));
  if (filter?.deadlineOpen) results.push(...collectLifecycleStatusResults(todayIso, 'deadline_open'));
  if (filter?.proofMissing) results.push(...collectLifecycleStatusResults(todayIso, 'proof_missing'));

  results = applyFilters(results, filter);
  return rankSearchResults(results).slice(0, options.limit ?? 30).map(presentResult);
}

export function isSearchQuestion(question: string): boolean {
  const q = normalizeSearchQuery(question);
  if (!q) return false;

  if (
    /welche aufgaben|was muss ich heute|was ist offen|offene rechnung|überfällig.*rechnung|wie viel geld|teilbezahlt|abschlag|was ist heute wichtig/.test(
      q,
    )
  ) {
    return false;
  }

  if (/^(zeig|welche|wo ist|wo liegt|suche|finde|gibt es)/.test(q)) return true;
  if (/antwort offen|offene briefe|papier fehlt|nicht abgeheftet|nachweis fehlt/.test(q)) return true;
  if (/schreiben vom|dokumente betreffen|originale fehlen|rechnungen sind offen/.test(q)) return true;
  return false;
}

function extractSearchQueryFromQuestion(question: string): string {
  return question
    .replace(/[?.!]/g, ' ')
    .replace(/zeig(e)? mir( bitte)?/gi, ' ')
    .replace(/welche|wo ist|wo liegt|suche|finde|gibt es/gi, ' ')
    .replace(/alle|mir|noch|bitte|schreiben vom|schreiben von|dokumente betreffen|briefe muss ich beantworten|originale fehlen noch im papierordner|rechnungen sind offen/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trySearchAssistantAnswer(
  question: string,
  todayIso: string = getTodayIso(),
): AssistantAnswer | null {
  if (!isSearchQuestion(question)) return null;

  const query = extractSearchQueryFromQuestion(question) || normalizeSearchQuery(question);
  const results = searchOffice({ query, todayIso, limit: 8 });
  if (results.length === 0) return null;

  const actions: AssistantAction[] = results.slice(0, 5).map((result) => ({
    id: result.id,
    label: result.title,
    route: result.route,
  }));

  // Titles/subtitles already come from DocumentSummary (inbox/document hits).
  return {
    title: 'Suchergebnisse',
    summary:
      results.length === 1
        ? `Ich habe 1 Treffer gefunden: ${results[0]!.title}.`
        : `Ich habe ${results.length} Treffer gefunden.`,
    bullets: results.slice(0, 5).map((result) => {
      const line = [result.title, result.subtitle, result.snippet]
        .filter(Boolean)
        .join(' · ');
      return line;
    }),
    actions,
    linkedRoute: results[0]?.route,
  };
}
