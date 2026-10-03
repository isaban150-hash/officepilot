/**
 * EINGANG-01D-1 — fachliche Wahrheit am Eingang.
 *
 * Echte Produktionsfunktionen: Klassifikation, `intakeCachedDocumentFile`
 * (inkl. DocumentWorkResult-Commit), Ausgabe aus dem Eingang, manuelle
 * Fristkorrektur, Cloud-Payload/Pull. Ersetzt wird nur die Bild-OCR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { classifyDocument, getClassificationForItem } from './documentClassificationService';
import { hydrateDocumentStore } from './documentService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import {
  getDocumentWorkResult,
  getDocumentWorkResultStoreSnapshot,
  resetDocumentWorkResultStoreForTests,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';
import { addExpense, getAllExpenses } from './expenseService';
import { hydrateExpenseStore } from './expenseStore';
import {
  getExpenseOpenAmount,
  isExpensePayable,
  resolveExpensePaymentStatus,
} from './expensePaymentCalculations';
import {
  getInboxItemById,
  getInboxStoreSnapshot,
  hydrateInboxStore,
  updateInboxItemRecognizedData,
} from './inboxService';
import { createTaskForItem } from './inboxTaskService';
import { analyzeUploadedDocument, commitUploadedDocumentAnalysis } from './intakeWorkflowService';
import { buildExpenseInputFromInbox, createExpenseFromInbox } from './officeActionService';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import * as persistenceService from './persistenceService';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import {
  buildInboxItemCloudPayload,
  buildWorkResultPushPayload,
  mergeInboxItemsFromPull,
  mergeWorkResultsFromPull,
  type CloudInboxRow,
  type CloudWorkResultRow,
} from './document/intakeCloudSyncService';
import { computeBufferContentHash } from './documentFileHashService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import { parseEmailMessageRow } from './email/emailMessageCloudService';
import { importEmailAttachmentToInbox } from './email/emailAttachmentIntakeService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { InboxItem } from '../types/models';

const WS = '00000000-0000-4000-8000-0000000001d1';

const TEXT = {
  invoice:
    'Baustoff Müller GmbH\nRechnung\nRechnungsnummer: R-2026-100\nRechnungsdatum: 01.10.2026\nMaterial 100,00 EUR\nUSt 19 % 19,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026',
  credit:
    'Baustoff Müller GmbH\nGutschrift\nGutschriftsnummer: GS-2026-7\nDatum: 01.10.2026\nRücknahme Material\nGesamtbetrag 119,00 EUR',
  creditNegative:
    'Baustoff Müller GmbH\nGutschrift\nGutschriftsnummer: GS-2026-8\nDatum: 01.10.2026\nRücknahme Material\nGesamtbetrag -119,00 EUR',
  bank:
    'Sparkasse Musterstadt\nKontoauszug Nr. 9\nBuchungstag Valuta Text\n01.10.2026 01.10.2026 Gutschrift Kunde Meyer 500,00 EUR\nAlter Saldo 1.000,00 EUR\nNeuer Saldo 1.500,00 EUR',
  invoiceMentionsCredit:
    'Baustoff Müller GmbH\nRechnung\nRechnungsnummer: R-2026-101\nRechnungsdatum: 01.10.2026\nMaterial 200,00 EUR\nGesamtbetrag 238,00 EUR\nZahlbar bis 15.10.2026\nEine eventuelle Gutschrift wird mit der nächsten Rechnung verrechnet.',
  correction:
    'Baustoff Müller GmbH\nRechnungskorrektur\nzur Rechnung R-2026-100 vom 01.10.2026\nRechnungsnummer: RK-2026-3\nDatum: 05.10.2026\nGesamtbetrag 107,10 EUR\nZahlbar bis 20.10.2026',
  storno:
    'Baustoff Müller GmbH\nStornorechnung\nStorno zur Rechnung R-2026-100\nDatum: 05.10.2026\nGesamtbetrag -119,00 EUR',
  selfBilling:
    'Kunde AG\nAbrechnungsgutschrift\nGutschrift im Gutschriftsverfahren gemäß § 14 Abs. 2 Satz 2 UStG\nGutschriftsnummer: AG-55\nDatum: 01.10.2026\nLeistung September 1.000,00 EUR\nGesamtbetrag 1.190,00 EUR',
  freistellung:
    'Finanzamt Musterstadt\nFreistellungsbescheinigung nach § 48 b EStG\nDie Freistellung gilt bis zum 31.08.2029.',
  response:
    'Landratsamt Musterkreis\nAnhörung\nSehr geehrte Damen und Herren,\nbitte nehmen Sie bis zum 20.10.2026 Stellung zu dem Sachverhalt.\nMit freundlichen Grüßen',
  submission:
    'Landratsamt Musterkreis\nAnforderung\nBitte die fehlenden Unterlagen bis zum 25.10.2026 einreichen.\nMit freundlichen Grüßen',
  info: 'Stadtwerke Musterstadt\nInformation zur Preisanpassung\nAb dem 01.01.2027 gelten neue Preise.\nMit freundlichen Grüßen',
} as const;

let ocrText = '';
let fileCounter = 0;

function payloadFor(name: string): CachedDocumentFilePayload {
  fileCounter += 1;
  const bytes = new TextEncoder().encode(`01d1-${name}-${fileCounter}`);
  return { fileName: `${name}.png`, mimeType: 'image/png', fileSize: bytes.length, bytes };
}

async function intake(text: string, name: string): Promise<InboxItem> {
  ocrText = text;
  const result = await intakeCachedDocumentFile(payloadFor(name), { importSource: 'upload', recognizedText: text });
  if (!result.success || result.duplicate) throw new Error(`intake failed for ${name}`);
  return getInboxItemById(result.inboxItem.id)!;
}

function cloudInboxRow(item: InboxItem): CloudInboxRow {
  return {
    client_inbox_id: item.id,
    status: item.status,
    vorgang_link_status: 'none',
    client_file_ref_id: item.fileRefId ?? null,
    archive_document_id: null,
    vorgang_id: null,
    expense_id: null,
    payload: JSON.parse(JSON.stringify(buildInboxItemCloudPayload(item))),
    updated_at: '2026-10-01T10:00:00.000Z',
    deleted: false,
    row_version: 1,
  };
}

useDocumentBlobDatabaseReset();

beforeEach(() => {
  localStorage.clear();
  fileCounter = 0;
  hydrateCompanyProfileStore(DEFAULT_COMPANY_PROFILE);
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateExpenseStore([]);
  setTaskStoreForTests([]);
  resetDocumentWorkResultStoreForTests();
  setImageOcrExtractorForTests(async () => ({ text: ocrText, confidence: 90 }));
});

afterEach(() => {
  setImageOcrExtractorForTests(null);
  vi.restoreAllMocks();
});

describe('01D-1 — Klassifikation am Belegkopf', () => {
  it('1: normale Eingangsrechnung bleibt Eingangsrechnung mit Zahlungsfrist', async () => {
    const item = await intake(TEXT.invoice, 'rechnung');
    expect(item.classifiedKind).toBe('eingangsrechnung');
    expect(item.deadline).toBe('2026-10-15');
    expect(item.deadlineType).toBe('payment_due');
    expect(item.financeReviewReason).toBeUndefined();

    const input = buildExpenseInputFromInbox(item);
    expect(input.grossAmount).toBe(119);
    expect(input.isCreditNote).toBeUndefined();
    expect(input.issueDate).toBe('2026-10-01');
    expect(input.paymentDueDate).toBe('2026-10-15');
  });

  it('2: Lieferantengutschrift (Kopfzeile) → gutschrift, keine Prüfspur', async () => {
    const item = await intake(TEXT.credit, 'gutschrift');
    expect(item.classifiedKind).toBe('gutschrift');
    expect(item.financeReviewReason).toBeUndefined();
  });

  it('3: Kontoauszug mit Buchungstext „Gutschrift" wird keine Gutschrift', () => {
    const result = classifyDocument({ recognizedText: TEXT.bank, sourceFileName: 'auszug.pdf' });
    expect(result.classifiedKind).toBe('kontoauszug');
    expect(result.financeReviewReason).toBeUndefined();
  });

  it('4: Rechnung, die eine Gutschrift nur erwähnt, bleibt Eingangsrechnung', () => {
    const result = classifyDocument({ recognizedText: TEXT.invoiceMentionsCredit, sourceFileName: 'rechnung.pdf' });
    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.financeReviewReason).toBeUndefined();
  });

  it('4b: Dateiname „gutschrift" ohne Belegtext macht keine Gutschrift', () => {
    const result = classifyDocument({ sourceFileName: 'gutschrift-mai.pdf' });
    expect(result.classifiedKind).not.toBe('gutschrift');
  });
});

describe('01D-1 — Korrektur, Storno, Abrechnungsgutschrift → Prüfen', () => {
  it.each([
    ['5a Rechnungskorrektur', TEXT.correction, 'invoice_correction'],
    ['5b Stornorechnung', TEXT.storno, 'invoice_correction'],
    ['6 Abrechnungsgutschrift', TEXT.selfBilling, 'self_billing_credit'],
  ] as const)('%s → Klären/Prüfen, nie Ausgabe', async (_label, text, reason) => {
    const item = await intake(text, `review-${reason}`);
    expect(item.financeReviewReason).toBe(reason);
    expect(item.classifiedKind).not.toBe('eingangsrechnung');
    expect(item.classifiedKind).not.toBe('rechnungskorrektur');
    expect(item.classifiedKind).not.toBe('gutschrift');

    const classification = getClassificationForItem(item);
    expect(classification.needsKindReview).toBe(true);
    expect(classification.recommendedAction).toBe('klaeren');
    expect(classification.processType).toBe('review_required');
    expect(classification.taskTemplate).toBeUndefined();
    expect(classification.actions.map((action) => action.id)).toEqual(['confirm_filing']);

    const result = createExpenseFromInbox(item);
    expect(result).toEqual({ ok: false, errorKey: 'document.accounting.financeReviewRequired' });
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('6b: Vertrag, der das Gutschriftsverfahren nur regelt, bleibt Vertrag', () => {
    const result = classifyDocument({
      recognizedText:
        'Werkvertrag\nzwischen Auftraggeber und Auftragnehmer\n§ 5 Vergütung\nDie Abrechnung erfolgt im Gutschriftsverfahren.\nUnterschrift',
      sourceFileName: 'vertrag.pdf',
    });
    expect(result.financeReviewReason).toBeUndefined();
  });
});

describe('01D-1 — Lieferantengutschrift ist keine offene Verbindlichkeit', () => {
  it('positiv gedruckt → negativer Beleg, Gutschrift, nichts offen, nicht zahlbar', async () => {
    const item = await intake(TEXT.credit, 'gutschrift-positiv');
    const input = buildExpenseInputFromInbox(item);
    expect(input.grossAmount).toBe(-119);
    expect(input.isCreditNote).toBe(true);
    expect(input.paymentDueDate).toBeUndefined();

    const created = addExpense(input);
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.expense.grossAmount).toBe(-119);
    expect(getExpenseOpenAmount(created.expense)).toBe(0);
    expect(isExpensePayable(created.expense)).toBe(false);
    expect(resolveExpensePaymentStatus(created.expense, '2026-10-01')).toBe('gutschrift');
  });

  it('negativ gedruckt → bleibt negativ (keine doppelte Umkehr)', async () => {
    const item = await intake(TEXT.creditNegative, 'gutschrift-negativ');
    expect(item.classifiedKind).toBe('gutschrift');
    expect(buildExpenseInputFromInbox(item).grossAmount).toBe(-119);
  });

  it('Rechnung bleibt positiv und offen', async () => {
    const item = await intake(TEXT.invoice, 'rechnung-offen');
    const created = addExpense(buildExpenseInputFromInbox(item));
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(getExpenseOpenAmount(created.expense)).toBe(119);
    expect(resolveExpensePaymentStatus(created.expense, '2026-10-01')).not.toBe('gutschrift');
  });
});

describe('01D-1 — Fristart', () => {
  it('7: Freistellung — Gültigkeitsende wird nie Handlungsfrist', async () => {
    const item = await intake(TEXT.freistellung, 'freistellung');
    expect(item.classifiedKind).toBe('freistellungsbescheinigung');
    expect(item.deadline ?? null).toBeNull();
    expect(item.deadlineType).toBeUndefined();
  });

  it('8: response_due wird kein Zahlungsziel und kein Belegdatum', async () => {
    const item = await intake(TEXT.response, 'anhoerung');
    expect(item.deadline).toBe('2026-10-20');
    expect(item.deadlineType).toBe('response_due');
    const input = buildExpenseInputFromInbox(item);
    expect(input.paymentDueDate).toBeUndefined();
    expect(input.issueDate).not.toBe('2026-10-20');
  });

  it('9: document_submission_due wird kein Zahlungsziel', async () => {
    const item = await intake(TEXT.submission, 'unterlagen');
    expect(item.deadline).toBe('2026-10-25');
    expect(item.deadlineType).toBe('document_submission_due');
    expect(buildExpenseInputFromInbox(item).paymentDueDate).toBeUndefined();
  });

  it('10: reine Information → keine Frist, kein Fristtyp', async () => {
    const item = await intake(TEXT.info, 'info');
    expect(item.deadline ?? null).toBeNull();
    expect(item.deadlineType).toBeUndefined();
  });

  it('11: manuelle Friständerung setzt den Fristtyp zurück; gleiche Frist behält ihn', async () => {
    const item = await intake(TEXT.invoice, 'rechnung-manuell');
    expect(item.deadlineType).toBe('payment_due');

    const same = updateInboxItemRecognizedData(item.id, { deadline: '2026-10-15' });
    expect(same?.deadlineType ?? getInboxItemById(item.id)!.deadlineType).toBe('payment_due');

    updateInboxItemRecognizedData(item.id, { deadline: '2026-11-30' });
    const changed = getInboxItemById(item.id)!;
    expect(changed.deadline).toBe('2026-11-30');
    expect(changed.deadlineType).toBeUndefined();
    expect(buildExpenseInputFromInbox(changed).paymentDueDate).toBeUndefined();
    // Belegdatum bleibt das gedruckte Datum, nie die (neue) Frist.
    expect(buildExpenseInputFromInbox(changed).issueDate).toBe('2026-10-01');
  });

  it('11b: Altbestand ohne Fristtyp → kein Zahlungsziel aus der Frist (konservativ)', () => {
    const item: InboxItem = {
      id: 'inbox-legacy-1d1',
      title: 'Alt',
      sender: 'Baustoff Alt GmbH',
      sourceFileName: 'alt.pdf',
      documentType: 'eingangsrechnung',
      status: 'neu',
      priority: 'mittel',
      kind: 'rechnung',
      classifiedKind: 'eingangsrechnung',
      deadline: '2026-10-15',
      digitalFolder: { id: 'd', name: 'Eingang', path: '/Eingang/' },
      paperFiling: { folderId: 'f', register: 'A', label: 'A' },
      recognizedData: { Betrag: '119,00', Datum: '01.10.2026' },
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    } as InboxItem;
    const input = buildExpenseInputFromInbox(item);
    expect(input.paymentDueDate).toBeUndefined();
    expect(input.issueDate).toBe('2026-10-01');
  });
});

describe('01D-1 — DocumentWorkResult beim Intake', () => {
  it('12: Upload committet das Analyseergebnis sofort (ohne Ansehen)', async () => {
    const item = await intake(TEXT.invoice, 'dwr-upload');
    const stored = getDocumentWorkResult(item.id);
    expect(stored).not.toBeNull();
    expect(stored!.inboxItemId).toBe(item.id);
  });

  it('12b: großes Dokument — Festschreiben nach dem Zeichnen, ohne Öffnen der Detailseite', async () => {
    const large = `${TEXT.invoice}\n${'Leistungsbeschreibung Position Material und Lohn gemäß Aufmaß.\n'.repeat(900)}`;
    expect(large.length).toBeGreaterThan(50_000);
    const item = await intake(large, 'dwr-large');
    await vi.waitFor(() => expect(getDocumentWorkResult(item.id)).not.toBeNull(), { timeout: 5_000, interval: 50 });
  });

  it('13: onlyIfMissing — Ansehen überschreibt das Intake-Ergebnis nicht', async () => {
    const item = await intake(TEXT.invoice, 'dwr-only-if-missing');
    const first = getDocumentWorkResult(item.id)!;
    const marked = { ...first, analyzedAt: '2000-01-01T00:00:00.000Z' };
    upsertDocumentWorkResult(marked);

    const again = analyzeUploadedDocument(item.id);
    expect(again).not.toBeNull();
    commitUploadedDocumentAnalysis(again!, 'onlyIfMissing');
    expect(getDocumentWorkResult(item.id)!.analyzedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('14: Duplikat erzeugt kein zweites Analyseergebnis', async () => {
    ocrText = TEXT.invoice;
    const bytes = new TextEncoder().encode('01d1-duplicate-bytes');
    const payload: CachedDocumentFilePayload = { fileName: 'dup.png', mimeType: 'image/png', fileSize: bytes.length, bytes };
    const first = await intakeCachedDocumentFile(payload, { importSource: 'upload', recognizedText: TEXT.invoice });
    expect(first.success && !first.duplicate).toBe(true);
    const second = await intakeCachedDocumentFile({ ...payload, bytes: bytes.slice() }, {
      importSource: 'upload',
      recognizedText: TEXT.invoice,
    });
    expect(second.success && second.duplicate).toBe(true);
    expect(getDocumentWorkResultStoreSnapshot()).toHaveLength(1);
    expect(getInboxStoreSnapshot()).toHaveLength(1);
  });

  it('15: Rollback bei fehlgeschlagener Persistenz hinterlässt kein Analyseergebnis', async () => {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    ocrText = TEXT.invoice;
    const result = await intakeCachedDocumentFile(payloadFor('rollback'), {
      importSource: 'upload',
      recognizedText: TEXT.invoice,
    });
    expect(result.success).toBe(false);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentWorkResultStoreSnapshot()).toHaveLength(0);
  });

  it('16: zweites Gerät — Fristtyp, Prüfgrund und Analyseergebnis kommen ohne _extractedText an', async () => {
    const invoice = await intake(TEXT.invoice, 'device-a-rechnung');
    const correction = await intake(TEXT.correction, 'device-a-korrektur');
    const workResults = getDocumentWorkResultStoreSnapshot();
    expect(workResults.map((entry) => entry.inboxItemId).sort()).toEqual([correction.id, invoice.id].sort());

    const inboxRows = [cloudInboxRow(invoice), cloudInboxRow(correction)];
    for (const row of inboxRows) {
      const recognized = row.payload.recognizedData as Record<string, string>;
      expect(Object.keys(recognized).some((key) => key.startsWith('_'))).toBe(false);
    }
    expect(inboxRows[0]!.payload.deadlineType).toBe('payment_due');
    expect(inboxRows[1]!.payload.financeReviewReason).toBe('invoice_correction');

    const workRows: CloudWorkResultRow[] = workResults.map((entry) => {
      const pushed = JSON.parse(JSON.stringify(buildWorkResultPushPayload(entry, false)));
      return { ...pushed, updated_at: '2026-10-01T10:00:00.000Z', row_version: 1 };
    });

    // Gerät B: leerer Speicher, nur Pull.
    hydrateInboxStore([]);
    resetDocumentWorkResultStoreForTests();
    const context = { deviceId: 'dev-b', workspaceId: WS, dirty: new Set<string>() };
    const pulledInbox = mergeInboxItemsFromPull([], inboxRows, context).items;
    const pulledWork = mergeWorkResultsFromPull([], workRows, context).items;
    expect(pulledWork.map((entry) => entry.inboxItemId).sort()).toEqual([correction.id, invoice.id].sort());

    const invoiceOnB = pulledInbox.find((entry) => entry.id === invoice.id)!;
    const correctionOnB = pulledInbox.find((entry) => entry.id === correction.id)!;
    expect(invoiceOnB.deadlineType).toBe('payment_due');
    expect(buildExpenseInputFromInbox(invoiceOnB).paymentDueDate).toBe('2026-10-15');
    expect(correctionOnB.financeReviewReason).toBe('invoice_correction');
    const reviewOnB = getClassificationForItem(correctionOnB);
    expect(reviewOnB.needsKindReview).toBe(true);
    expect(reviewOnB.recommendedAction).toBe('klaeren');
    expect(createExpenseFromInbox(correctionOnB)).toEqual({
      ok: false,
      errorKey: 'document.accounting.financeReviewRequired',
    });
  });
});

describe('01D-1 — Aufgaben unverändert', () => {
  it('17: Aufgabe aus Rechnung wird nicht doppelt angelegt', async () => {
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Mustermann Sanitär GmbH',
      street: 'Handwerkerweg 7',
      zip: '10115',
      city: 'Berlin',
    });
    const item = await intake(
      TEXT.invoice.replace('Rechnung\n', 'An: Mustermann Sanitär GmbH\nHandwerkerweg 7\n10115 Berlin\nRechnung\n'),
      'task-dedupe',
    );
    createTaskForItem(item.id);
    const afterFirst = getAllTasksFromStore().length;
    expect(afterFirst).toBeGreaterThan(0);
    createTaskForItem(item.id);
    expect(getAllTasksFromStore().length).toBe(afterFirst);
  });
});

describe('01D-1 — Mail-Anhang (01B-Pfad)', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
  });

  it('18: Korrektur als Mail-Anhang → Analyseergebnis sofort da, Prüfgrund gesetzt, keine Ausgabe', async () => {
    setPdfTextExtractorForTests(() => TEXT.correction);
    const bytes = new TextEncoder().encode('%PDF-1.4\nkorrektur-mail\n%%EOF');
    const sha = await computeBufferContentHash(bytes);
    const path = `${WS}/${sha}.pdf`;
    const message = parseEmailMessageRow({
      id: 'msg-1d1', workspace_id: WS, client_message_id: 'in:c:1d1', direction: 'inbound', provider: 'microsoft_graph',
      provider_message_id: 'p-1d1', mailbox_connection_id: 'conn-1', internet_message_id: '<1d1@x>',
      from_address: 'buchhaltung@lieferant.invalid', from_name: 'Baustoff Müller GmbH',
      to_recipients: ['info@example.invalid'], cc_recipients: [], bcc_recipients: [],
      subject: 'Rechnungskorrektur RK-2026-3', body_text: 'Anbei die Korrektur.', has_html: false, status: 'received',
      received_at: '2026-10-01T08:15:00.000Z', imported_at: '2026-10-01T08:16:00.000Z', created_at: '2026-10-01T08:16:00.000Z',
      attempt_number: 1, row_version: 1, customer_id: null, vorgang_id: null, assignment_status: 'needs_review',
      assignment_source: null, skipped_attachments: [],
      attachments: [{
        id: 'att-1d1', position: 1, filename: 'korrektur.pdf', mime_type: 'application/pdf', size_bytes: bytes.length,
        sha256: sha, storage_path: path, storage_bucket: 'inbound-email-attachments',
      }],
    });
    expect(message).not.toBeNull();

    const result = await importEmailAttachmentToInbox(message!, message!.attachments[0]!, {
      access: { canWrite: true, canIntake: true, role: 'owner', reason: 'owner_or_admin' },
      download: async (input) =>
        input.storagePath === path
          ? { ok: true, blob: new Blob([bytes], { type: input.mimeType }) }
          : { ok: false, error: 'missing' },
      now: () => '2026-10-01T10:00:00.000Z',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;

    const item = getInboxItemById(result.inboxItemId)!;
    expect(item.importSource).toBe('email');
    expect(item.financeReviewReason).toBe('invoice_correction');
    expect(getDocumentWorkResult(item.id)).not.toBeNull();
    expect(createExpenseFromInbox(item)).toEqual({ ok: false, errorKey: 'document.accounting.financeReviewRequired' });
    expect(getAllExpenses()).toHaveLength(0);
  });
});
