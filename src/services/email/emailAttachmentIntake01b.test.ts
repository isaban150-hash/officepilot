/**
 * EINGANG-01B — eingegangener Mail-Anhang → bestehender Dokumenteingang.
 *
 * Echte Produktionsfunktionen: Vorschau (`processDocumentFileForPreview`),
 * Entscheidung (`executePendingDocumentDecision`), `intakeCachedDocumentFile`,
 * Blob-Speicher, Duplikaterkennung, Workflow-Analyse (01A) und die
 * Cloud-Payload-/Pull-Funktionen. Ersetzt werden nur der Storage-Download
 * (kein Netz) und der PDF-Textextraktor (kein pdf.js im Test).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../../test/documentBlobTestReset';
import { createTestVorgang } from '../../test/fixtures';
import { computeBufferContentHash } from '../documentFileHashService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateDocumentStore } from '../documentService';
import { getInboxItemById, getInboxStoreSnapshot, hydrateInboxStore } from '../inboxService';
import { analyzeUploadedDocument } from '../intakeWorkflowService';
import { executePendingDocumentDecision } from '../pendingDocumentDecisionService';
import { processDocumentFileForPreview } from '../pendingDocumentIntakeService';
import { setPdfTextExtractorForTests } from '../uploadTextExtractionService';
import { hydrateVorgangStore } from '../vorgangService';
import { withTombstonedEntity } from '../sync/syncMetaService';
import {
  buildInboxItemCloudPayload,
  mergeInboxItemsFromPull,
  type CloudInboxRow,
} from '../document/intakeCloudSyncService';
import { parseEmailMessageRow } from './emailMessageCloudService';
import {
  emailAttachmentInboxItemId,
  findInboxItemForEmailAttachment,
  importEmailAttachmentToInbox,
  isEmailAttachmentIntakeEligible,
  type EmailAttachmentIntakeDeps,
} from './emailAttachmentIntakeService';
import type { EmailMessage, EmailMessageAttachment } from '../../types/emailMessage';
import type { InboxItem } from '../../types/models';
import type { WorkspaceWriteAccess } from '../workspace/workspaceRoleService';

const WS = '00000000-0000-4000-8000-0000000001b0';
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
const INVOICE_TEXT =
  'Rechnung\nAn: Mustermann Sanitär GmbH\nRechnungsnummer: R-77\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026';
const OWNER: WorkspaceWriteAccess = { canWrite: true, canIntake: true, role: 'owner', reason: 'owner_or_admin' };
const UNKNOWN: WorkspaceWriteAccess = { canWrite: false, canIntake: false, role: null, reason: 'membership_unknown' };

function pdfBytes(marker: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${marker}\n%%EOF`);
}

/** Speicher des Eingangs-Buckets für den Test-Download: Pfad → Bytes. */
let bucket: Map<string, Uint8Array>;
let downloads: string[];
let extractions: number;

const download: NonNullable<EmailAttachmentIntakeDeps['download']> = async (input) => {
  downloads.push(input.storagePath);
  const bytes = bucket.get(input.storagePath);
  if (!bytes) return { ok: false, error: 'missing' };
  return { ok: true, blob: new Blob([bytes], { type: input.mimeType }) };
};

async function attachmentRow(
  id: string,
  bytes: Uint8Array,
  patch: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const sha = await computeBufferContentHash(bytes);
  const path = `${WS}/${sha}.pdf`;
  bucket.set(path, bytes);
  return {
    id,
    position: 1,
    filename: 'rechnung.pdf',
    mime_type: 'application/pdf',
    size_bytes: bytes.length,
    sha256: sha,
    storage_path: path,
    storage_bucket: 'inbound-email-attachments',
    ...patch,
  };
}

function messageRow(attachments: Record<string, unknown>[], patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1', workspace_id: WS, client_message_id: 'in:c:1', direction: 'inbound', provider: 'microsoft_graph',
    provider_message_id: 'p-1', mailbox_connection_id: 'conn-1', internet_message_id: '<a@x>',
    from_address: 'buchhaltung@lieferant.invalid', from_name: 'Baustoff Meyer GmbH',
    to_recipients: ['info@mustermann-sanitaer.de'], cc_recipients: [], bcc_recipients: [],
    subject: 'Rechnung R-77', body_text: 'Anbei die Rechnung.', has_html: false, status: 'received',
    received_at: '2026-09-27T08:15:00.000Z', imported_at: '2026-09-27T08:16:00.000Z', created_at: '2026-09-27T08:16:00.000Z',
    attempt_number: 1, row_version: 1, customer_id: null, vorgang_id: null, assignment_status: 'needs_review',
    assignment_source: null, skipped_attachments: [], attachments,
    ...patch,
  };
}

function parse(row: Record<string, unknown>): EmailMessage {
  const message = parseEmailMessageRow(row);
  if (!message) throw new Error('Testnachricht ungültig');
  return message;
}

function emailItems(): InboxItem[] {
  return getInboxStoreSnapshot().filter((item) => item.importSource === 'email');
}

const deps = (patch: Partial<EmailAttachmentIntakeDeps> = {}): EmailAttachmentIntakeDeps => ({
  access: OWNER,
  download,
  now: () => '2026-09-30T10:00:00.000Z',
  ...patch,
});

useDocumentBlobDatabaseReset();

beforeEach(() => {
  localStorage.clear();
  bucket = new Map();
  downloads = [];
  extractions = 0;
  hydrateCompanyProfileStore(PROFILE);
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  setPdfTextExtractorForTests(() => {
    extractions += 1;
    return INVOICE_TEXT;
  });
});

afterEach(() => {
  setPdfTextExtractorForTests(null);
});

describe('EINGANG-01B — Anhang-ID im Client', () => {
  it('die Server-UUID des Anhangs wird geparst; ohne ID keine Ersatz-ID', async () => {
    const withId = parse(messageRow([await attachmentRow('att-uuid-1', pdfBytes('a'))]));
    expect(withId.attachments[0]!.id).toBe('att-uuid-1');
    const { id: _dropped, ...withoutIdRow } = await attachmentRow('x', pdfBytes('b'));
    const withoutId = parse(messageRow([withoutIdRow]));
    expect(withoutId.attachments[0]!.id).toBeUndefined();
    expect(isEmailAttachmentIntakeEligible(withoutId.attachments[0]!)).toEqual({ eligible: false, reason: 'no_id' });
  });
});

describe('EINGANG-01B — Übernahme', () => {
  it('T1: PDF-Anhang → genau ein Eingang mit Mail-Herkunft über die bestehende Pipeline', async () => {
    const bytes = pdfBytes('rechnung-77');
    const message = parse(messageRow([await attachmentRow('att-1', bytes)]));
    const attachment = message.attachments[0]!;

    const result = await importEmailAttachmentToInbox(message, attachment, deps());

    expect(result).toEqual({ outcome: 'created', inboxItemId: 'inbox-mail-att-1' });
    const items = emailItems();
    expect(items).toHaveLength(1);
    const item = getInboxItemById('inbox-mail-att-1')!;
    expect(item.importSource).toBe('email');
    expect(item.mailImportId).toBeUndefined();
    expect(item.emailOrigin).toEqual({
      messageId: 'msg-1',
      attachmentId: 'att-1',
      position: 1,
      sha256: attachment.sha256,
      receivedAt: '2026-09-27T08:15:00.000Z',
      importedAt: '2026-09-30T10:00:00.000Z',
    });
    expect(item.fileRefId).toBeTruthy();
    expect(item.sourceFileHash).toBe(attachment.sha256);
    expect(item.sender).toBe('Baustoff Meyer GmbH');
    // Bestehende Pipeline: OCR genau einmal, Klassifikation und 01A-Frist aktiv.
    expect(extractions).toBe(1);
    expect(item.classifiedKind).toBe('eingangsrechnung');
    expect(item.deadline).toBe('2026-10-15');
  });

  it('T2: zweiter Aufruf desselben Anhangs → already_imported, kein zweiter Download, kein zweiter Eingang', async () => {
    const message = parse(messageRow([await attachmentRow('att-2', pdfBytes('zwei'))]));
    const first = await importEmailAttachmentToInbox(message, message.attachments[0]!, deps());
    expect(first.outcome).toBe('created');
    const second = await importEmailAttachmentToInbox(message, message.attachments[0]!, deps());
    expect(second).toEqual({ outcome: 'already_imported', inboxItemId: 'inbox-mail-att-2' });
    expect(downloads).toHaveLength(1);
    expect(emailItems()).toHaveLength(1);
  });

  it('T2b: Doppelklick (paralleler Aufruf) → genau ein Eingang', async () => {
    const message = parse(messageRow([await attachmentRow('att-2b', pdfBytes('doppel'))]));
    const [a, b] = await Promise.all([
      importEmailAttachmentToInbox(message, message.attachments[0]!, deps()),
      importEmailAttachmentToInbox(message, message.attachments[0]!, deps()),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['created', 'failed']);
    expect([a, b].find((r) => r.outcome === 'failed')).toMatchObject({ error: 'in_progress' });
    expect(emailItems()).toHaveLength(1);
  });

  it('T3: dieselbe Anhang-ID nach erneutem Laden der Mail → kein zweiter Eingang', async () => {
    const row = messageRow([await attachmentRow('att-3', pdfBytes('drei'))]);
    const loaded = parse(row);
    expect((await importEmailAttachmentToInbox(loaded, loaded.attachments[0]!, deps())).outcome).toBe('created');

    const reloaded = parse(JSON.parse(JSON.stringify(row)));
    expect(findInboxItemForEmailAttachment(reloaded.attachments[0]!.id)?.item.id).toBe('inbox-mail-att-3');
    const again = await importEmailAttachmentToInbox(reloaded, reloaded.attachments[0]!, deps());
    expect(again).toEqual({ outcome: 'already_imported', inboxItemId: 'inbox-mail-att-3' });
    expect(emailItems()).toHaveLength(1);
  });

  it('T4: gleicher Dateiname, andere Bytes → zwei getrennte, richtig zugeordnete Eingänge', async () => {
    const a = await attachmentRow('att-4a', pdfBytes('inhalt-a'));
    const b = await attachmentRow('att-4b', pdfBytes('inhalt-b'), { position: 2 });
    const message = parse(messageRow([a, b]));
    for (const attachment of message.attachments) {
      expect((await importEmailAttachmentToInbox(message, attachment, deps())).outcome).toBe('created');
    }
    expect(emailItems()).toHaveLength(2);
    expect(getInboxItemById('inbox-mail-att-4a')!.sourceFileHash).toBe(a.sha256);
    expect(getInboxItemById('inbox-mail-att-4b')!.sourceFileHash).toBe(b.sha256);
    expect(getInboxItemById('inbox-mail-att-4b')!.emailOrigin?.position).toBe(2);
  });

  it('T5: gleiche Bytes aus einer anderen Mail → Inhaltsduplikat, kein zweiter Eingang', async () => {
    const bytes = pdfBytes('gleich');
    const first = parse(messageRow([await attachmentRow('att-5a', bytes)]));
    const second = parse(messageRow([await attachmentRow('att-5b', bytes)], { id: 'msg-2', client_message_id: 'in:c:2', provider_message_id: 'p-2', internet_message_id: '<b@x>' }));

    expect((await importEmailAttachmentToInbox(first, first.attachments[0]!, deps())).outcome).toBe('created');
    const duplicate = await importEmailAttachmentToInbox(second, second.attachments[0]!, deps());

    expect(duplicate).toEqual({ outcome: 'duplicate', existing: { type: 'inbox', id: 'inbox-mail-att-5a' } });
    expect(emailItems()).toHaveLength(1);
    expect(getInboxItemById('inbox-mail-att-5b')).toBeUndefined();
  });
});

describe('EINGANG-01B — keine Vorgangsvererbung aus der Mail (01A bleibt wirksam)', () => {
  beforeEach(() => {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-meyer', title: 'Lager Meyer', customer: 'Baustoff Meyer GmbH', status: 'in_bearbeitung' }),
    ]);
  });

  async function importAndAnalyze(patch: Record<string, unknown>, attachmentId: string) {
    const message = parse(messageRow([await attachmentRow(attachmentId, pdfBytes(attachmentId))], patch));
    const result = await importEmailAttachmentToInbox(message, message.attachments[0]!, deps());
    expect(result.outcome).toBe('created');
    const item = getInboxItemById(emailAttachmentInboxItemId(attachmentId))!;
    return { item, workflow: analyzeUploadedDocument(item.id) };
  }

  it('T6: needs_review mit suggested_vorgang_id → kein Vorgang am Eingang, keine link_vorgang-Aktion', async () => {
    const { item, workflow } = await importAndAnalyze(
      { assignment_status: 'needs_review', suggested_vorgang_id: 'v-meyer' },
      'att-6',
    );
    expect(item.vorgangId).toBeUndefined();
    expect(item.vorgangTitle).toBeUndefined();
    expect(item.vorgangLinkStatus).toBeUndefined();
    expect(workflow?.suggestedVorgang ?? null).toBeNull();
    expect(workflow?.nextActions.some((action) => action.id === 'link_vorgang')).toBe(false);
  });

  it('T7: manuell zugeordnete Mail (manual + vorgang_id) → ebenfalls kein Vorgang am Eingang', async () => {
    const { item, workflow } = await importAndAnalyze(
      { assignment_status: 'assigned', assignment_source: 'manual', customer_id: 'c-1', vorgang_id: 'v-meyer' },
      'att-7',
    );
    expect(item.vorgangId).toBeUndefined();
    expect(item.vorgangTitle).toBeUndefined();
    expect(workflow?.suggestedVorgang ?? null).toBeNull();
    expect(workflow?.nextActions.some((action) => action.id === 'link_vorgang')).toBe(false);
  });

  it('T14: 01A-Gegenprobe — Absender = Kunde eines Vorgangs verknüpft nicht automatisch', async () => {
    const { item, workflow } = await importAndAnalyze({}, 'att-14');
    expect(item.sender).toBe('Baustoff Meyer GmbH');
    expect(workflow?.suggestedVorgang ?? null).toBeNull();
    expect(workflow?.nextActions.some((action) => action.id === 'link_vorgang')).toBe(false);
  });
});

describe('EINGANG-01B — Eignung, Sicherheit, Berechtigung', () => {
  it('T8: DOCX/TXT/CSV → kein Intake, kein Download', async () => {
    const cases = [
      { filename: 'liste.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { filename: 'notiz.txt', mime_type: 'text/plain' },
      { filename: 'daten.csv', mime_type: 'text/csv' },
    ];
    for (const [index, patch] of cases.entries()) {
      const message = parse(messageRow([await attachmentRow(`att-8-${index}`, pdfBytes(`t${index}`), patch)]));
      const attachment = message.attachments[0]!;
      expect(isEmailAttachmentIntakeEligible(attachment)).toEqual({ eligible: false, reason: 'type' });
      expect(await importEmailAttachmentToInbox(message, attachment, deps())).toEqual({ outcome: 'failed', error: 'not_eligible' });
    }
    expect(downloads).toHaveLength(0);
    expect(emailItems()).toHaveLength(0);
  });

  it('PNG/JPEG sind geeignet; ausgehende Anhänge nicht', async () => {
    const png = parse(messageRow([await attachmentRow('att-png', pdfBytes('p'), { filename: 'foto.png', mime_type: 'image/png' })])).attachments[0]!;
    const jpg = parse(messageRow([await attachmentRow('att-jpg', pdfBytes('j'), { filename: 'scan.JPG', mime_type: 'image/jpeg' })])).attachments[0]!;
    const outbound = parse(messageRow([await attachmentRow('att-out', pdfBytes('o'), { storage_bucket: 'email-attachments' })])).attachments[0]!;
    expect(isEmailAttachmentIntakeEligible(png)).toEqual({ eligible: true });
    expect(isEmailAttachmentIntakeEligible(jpg)).toEqual({ eligible: true });
    expect(isEmailAttachmentIntakeEligible(outbound)).toEqual({ eligible: false, reason: 'not_inbound' });
  });

  it('T9: über 10 MB → kein Intake, kein Download', async () => {
    const message = parse(messageRow([await attachmentRow('att-9', pdfBytes('gross'), { size_bytes: 10 * 1024 * 1024 + 1 })]));
    const attachment = message.attachments[0]!;
    expect(isEmailAttachmentIntakeEligible(attachment)).toEqual({ eligible: false, reason: 'too_large' });
    expect(await importEmailAttachmentToInbox(message, attachment, deps())).toEqual({ outcome: 'failed', error: 'too_large' });
    expect(downloads).toHaveLength(0);
    expect(emailItems()).toHaveLength(0);
  });

  it('T10: geladene Bytes ≠ gespeicherter SHA-256 → Abbruch vor der Vorschau, kein Eingang', async () => {
    const message = parse(messageRow([await attachmentRow('att-10', pdfBytes('original'))]));
    const attachment = message.attachments[0]!;
    bucket.set(attachment.storagePath, pdfBytes('manipuliert'));

    const result = await importEmailAttachmentToInbox(message, attachment, deps());

    expect(result).toEqual({ outcome: 'failed', error: 'hash_mismatch' });
    expect(extractions).toBe(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });

  it('T11: canIntake false → kein Download, kein Eingang', async () => {
    const message = parse(messageRow([await attachmentRow('att-11', pdfBytes('elf'))]));
    const result = await importEmailAttachmentToInbox(message, message.attachments[0]!, deps({ access: UNKNOWN }));
    expect(result).toEqual({ outcome: 'failed', error: 'not_permitted' });
    expect(downloads).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });

  it('T12: unbekannte Mitgliedschaft (echter Resolver, Cloud aktiv) → fail-closed', async () => {
    const message = parse(messageRow([await attachmentRow('att-12', pdfBytes('zwoelf'))]));
    const result = await importEmailAttachmentToInbox(message, message.attachments[0]!, {
      userId: 'user-ohne-mitgliedschaft',
      cloudConfigured: true,
      download,
    });
    expect(result).toEqual({ outcome: 'failed', error: 'not_permitted' });
    expect(downloads).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });

  it('Download-Fehler werden unterschieden und nicht als Erfolg gemeldet', async () => {
    const message = parse(messageRow([await attachmentRow('att-dl', pdfBytes('dl'))]));
    const attachment = message.attachments[0]!;
    const forbidden = await importEmailAttachmentToInbox(message, attachment, deps({ download: async () => ({ ok: false, error: 'forbidden' }) }));
    expect(forbidden).toMatchObject({ outcome: 'failed', error: 'download_forbidden' });
    const network = await importEmailAttachmentToInbox(message, attachment, deps({ download: async () => ({ ok: false, error: 'network' }) }));
    expect(network).toMatchObject({ outcome: 'failed', error: 'download_failed' });
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });

  it('aus dem Eingang entfernter Anhang (Grabstein) → keine zweite Übernahme unter derselben ID', async () => {
    const message = parse(messageRow([await attachmentRow('att-del', pdfBytes('del'))]));
    expect((await importEmailAttachmentToInbox(message, message.attachments[0]!, deps())).outcome).toBe('created');
    const imported = getInboxItemById('inbox-mail-att-del')!;
    hydrateInboxStore([withTombstonedEntity(imported, 'inbox_item')]);

    const again = await importEmailAttachmentToInbox(message, message.attachments[0]!, deps());
    expect(again).toEqual({ outcome: 'failed', error: 'previously_removed' });
    expect(getInboxStoreSnapshot().filter((item) => item.id === 'inbox-mail-att-del')).toHaveLength(1);
  });
});

describe('EINGANG-01B — Cloud-Sync der Herkunft', () => {
  it('T13: emailOrigin bleibt im Cloud-Payload und nach dem Pull auf Gerät B erhalten', async () => {
    const message = parse(messageRow([await attachmentRow('att-13', pdfBytes('dreizehn'))]));
    expect((await importEmailAttachmentToInbox(message, message.attachments[0]!, deps())).outcome).toBe('created');
    const item = getInboxItemById('inbox-mail-att-13')!;

    const payload = buildInboxItemCloudPayload(item);
    expect(payload.emailOrigin).toEqual(item.emailOrigin);
    expect(payload.importSource).toBe('email');
    // `_`-Felder bleiben wie bisher lokal.
    expect(Object.keys(payload.recognizedData as Record<string, string>).some((key) => key.startsWith('_'))).toBe(false);

    const row: CloudInboxRow = {
      client_inbox_id: item.id, status: item.status, vorgang_link_status: 'none', client_file_ref_id: item.fileRefId ?? null,
      archive_document_id: null, vorgang_id: null, expense_id: null, payload: JSON.parse(JSON.stringify(payload)),
      updated_at: '2026-09-30T10:00:00.000Z', deleted: false, row_version: 1,
    };
    const onDeviceB = mergeInboxItemsFromPull([], [row], { deviceId: 'dev-b', workspaceId: WS, dirty: new Set() });
    expect(onDeviceB.items[0]!.emailOrigin).toEqual(item.emailOrigin);
    expect(onDeviceB.items[0]!.importSource).toBe('email');
    expect(onDeviceB.items[0]!.vorgangId).toBeUndefined();
  });
});

describe('EINGANG-01B — normaler Upload unverändert', () => {
  it('T17: Upload ohne Mail-Herkunft behält ID-Schema und hat kein emailOrigin', async () => {
    const preview = await processDocumentFileForPreview(new File([pdfBytes('upload')], 'upload.pdf', { type: 'application/pdf' }));
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    const result = await executePendingDocumentDecision(preview.pending, 'save_permanently', { importSource: 'upload' });
    expect('success' in result && result.success && !result.duplicate).toBe(true);
    if (!('success' in result) || !result.success || result.duplicate) return;
    expect(result.inboxItem.id).toMatch(/^inbox-upload-\d+$/);
    expect(result.inboxItem.emailOrigin).toBeUndefined();
    expect(result.inboxItem.importSource).toBe('upload');
  });
});
