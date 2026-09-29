/**
 * E-MAIL-07B — Client-Vertrag: Statusmaschine mit `sending`, offener unklarer
 * Versuch, Archiv-PDF aus Bildquelle, kanonischer Anhangsname, bestätigter
 * Neuversuch und Missbrauchsschutz im RPC-Vertrag, Orchestrator `in_progress`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canTransitionDeliveryStatus,
  findOpenUncertainDelivery,
  hasUncertainDelivery,
  isDeliveryInProgress,
  parseDocumentDeliveryRow,
} from './documentDeliveryContract';
import {
  buildArchivedDocumentAttachmentFilename,
  findArchivedDocumentPdfFileRefId,
  prepareArchivedDocumentDeliveryAttachment,
  resolveArchivedDocumentDeliveryKind,
  rpcCreateWorkspaceDocumentDelivery,
  type CreateDocumentDeliveryInput,
} from './documentDeliveryCloudService';
import * as orchestrator from './sendDocumentOrchestrator';
import { deliveryErrorLabelKey, deliveryStatusLabelKey } from './documentDeliveryDefaults';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../persistenceService';
import { hydrateDocumentFileStore, resetDocumentFileStoreForTests } from '../documentFileStoreService';
import {
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from '../documentFileRepresentationBindingStoreService';
import { hydrateDocumentStore } from '../documentService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import { resetTestStores } from '../../test/resetStores';
import { de } from '../../i18n';
import type { CompanyDocument } from '../../types/models';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { DocumentFileRef } from '../../types/documentFileRef';

const WS = '00000000-0000-4000-8000-0000000c07b7';
const PDF_DATA_URL = 'data:application/pdf;base64,' + btoa('%PDF-1.4 archiv');
const PNG_DATA_URL = 'data:image/png;base64,' + btoa('\x89PNG kein pdf');

function fileRef(id: string, mimeType = 'application/pdf', lifecycleStatus: DocumentFileRef['lifecycleStatus'] = 'committed'): DocumentFileRef {
  return { id, originalFileName: mimeType === 'application/pdf' ? 'a.pdf' : 'foto.png', mimeType, fileSize: 20, contentHash: `hash-${id}`, storageType: 'local_data_url', localDataKey: `blob-${id}`, createdAt: '2026-09-01T00:00:00.000Z', lifecycleStatus };
}

function doc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-7b', title: 'Aufmass Foto', category: 'sonstiges', issuer: '', recognizedText: '', issueDate: null, validUntil: null,
    digitalFolder: { id: 'd', name: 'D', path: '/D/' }, paperFolder: { folderId: 'f', register: 'A', label: 'F' }, tags: [], linkedCompany: '',
    linkedVorgang: null, archived: false, createdAt: '2026-09-01T00:00:00.000Z', fileRefId: 'fr-png', mimeType: 'image/png', ...overrides,
  };
}

function delivery(overrides: Partial<DocumentDelivery>): DocumentDelivery {
  return { id: 'd-1', workspaceId: WS, clientDeliveryId: 'cd-1', documentKind: 'invoice', linkedInvoiceId: 'inv-1', recipientEmail: 'kunde@example.invalid', subject: 'S', bodyText: 'B', provider: 'stub', status: 'queued', requestedBy: 'u', requestedAt: '2026-09-14T10:00:00.000Z', attemptNumber: 1, createdAt: '', updatedAt: '', rowVersion: 1, ...overrides };
}

beforeEach(() => {
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  vi.restoreAllMocks();
});

/* ================================================================== */

describe('07B — Statusmaschine und unklare Versuche', () => {
  it('sending liegt zwischen queued und dem Ergebnis; nie zurück, nie aus unknown', () => {
    expect(canTransitionDeliveryStatus('queued', 'sending')).toBe(true);
    expect(canTransitionDeliveryStatus('sending', 'provider_accepted')).toBe(true);
    expect(canTransitionDeliveryStatus('sending', 'failed')).toBe(true);
    expect(canTransitionDeliveryStatus('sending', 'unknown')).toBe(true);
    expect(canTransitionDeliveryStatus('sending', 'queued')).toBe(false);
    expect(canTransitionDeliveryStatus('unknown', 'sending')).toBe(false);
    expect(canTransitionDeliveryStatus('provider_accepted', 'sending')).toBe(false);
    expect(isDeliveryInProgress('sending')).toBe(true);
    expect(isDeliveryInProgress('queued')).toBe(false);
  });

  it('der Client liest sending-Zeilen (fail-closed-Parser kennt den Status)', () => {
    const row = {
      id: 'd', workspace_id: WS, client_delivery_id: 'cd', document_kind: 'invoice', linked_invoice_id: 'inv', recipient_email: 'a@b.invalid',
      subject: 'S', body_text: 'B', provider: 'stub', status: 'sending', requested_by: 'u', requested_at: 'x', created_at: 'x', updated_at: 'x',
      attempt_number: 1, row_version: 2, sending_started_at: 'x',
    };
    expect(parseDocumentDeliveryRow(row)?.status).toBe('sending');
  });

  it('ein unklarer Versuch ist offen, bis ein Neuversuch läuft oder gelingt; scheitert der, ist er wieder offen', () => {
    const unklar = delivery({ id: 'u', status: 'unknown' });
    expect(findOpenUncertainDelivery([unklar])?.id).toBe('u');
    for (const status of ['queued', 'sending', 'provider_accepted', 'unknown'] as const) {
      expect(hasUncertainDelivery([delivery({ id: 'n', status, retryOfDeliveryId: 'u' }), unklar]), status).toBe(status === 'unknown');
    }
    // Der Neuversuch ist selbst unklar: der alte ist beantwortet, der neue offen.
    expect(findOpenUncertainDelivery([delivery({ id: 'n', status: 'unknown', retryOfDeliveryId: 'u' }), unklar])?.id).toBe('n');
    for (const status of ['failed', 'rejected'] as const) {
      expect(findOpenUncertainDelivery([delivery({ id: 'n', status, retryOfDeliveryId: 'u' }), unklar])?.id, status).toBe('u');
    }
  });

  it('Statusanzeige: sending hat einen Text, keine Zustellung wird behauptet', () => {
    const texte = de as Record<string, string>;
    expect(texte[deliveryStatusLabelKey('sending')]).toBe('Wird an den E-Mail-Dienst übergeben');
    expect(texte[deliveryStatusLabelKey('provider_accepted')]).toBe('An E-Mail-Dienst übergeben');
    expect(texte[deliveryStatusLabelKey('sending')]).not.toMatch(/zugestellt/i);
  });

  it('Fehlertexte: eigene Texte für Testempfänger und Antwortadresse, sonst Kategorie', () => {
    const texte = de as Record<string, string>;
    expect(texte[deliveryErrorLabelKey({ errorCategory: 'recipient', errorCode: 'test_recipient_not_allowed' })]).toContain('Testmodus');
    expect(texte[deliveryErrorLabelKey({ errorCategory: 'unknown', errorCode: 'sender_reply_to_invalid' })]).toContain('Antwortadresse');
    expect(deliveryErrorLabelKey({ errorCategory: 'provider', errorCode: 'irgendwas' })).toBe('delivery.error.provider');
  });
});

describe('07B — Archiv-PDF und Dateiname', () => {
  it('Original-PDF: versendbar', () => {
    hydrateDocumentFileStore([fileRef('fr-pdf')], { 'blob-fr-pdf': PDF_DATA_URL });
    expect(findArchivedDocumentPdfFileRefId(doc({ fileRefId: 'fr-pdf', mimeType: 'application/pdf' }))).toBe('fr-pdf');
  });

  it('Bild + gültiges Archiv-PDF: das Archiv-PDF ist versendbar (bis 07B: „keine PDF-Datei")', async () => {
    hydrateDocumentFileStore([fileRef('fr-png', 'image/png'), fileRef('fr-archiv')], { 'blob-fr-png': PNG_DATA_URL, 'blob-fr-archiv': PDF_DATA_URL });
    hydrateDocumentFileRepresentationBindingStore([{ documentId: 'doc-7b', kind: 'archive', fileRefId: 'fr-archiv' }] as never);
    const dokument = doc();
    hydrateDocumentStore([dokument]);
    expect(findArchivedDocumentPdfFileRefId(dokument)).toBe('fr-archiv');
    const anhang = await prepareArchivedDocumentDeliveryAttachment(dokument);
    expect(anhang.ok).toBe(true);
    if (anhang.ok) expect(String.fromCharCode(...anhang.attachment.bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('nur Bild ohne Archiv-PDF: nicht versendbar — ein Bild wird nie als PDF behandelt', async () => {
    hydrateDocumentFileStore([fileRef('fr-png', 'image/png')], { 'blob-fr-png': PNG_DATA_URL });
    expect(findArchivedDocumentPdfFileRefId(doc())).toBeNull();
    expect(await prepareArchivedDocumentDeliveryAttachment(doc())).toEqual({ ok: false, reason: 'no_pdf' });
  });

  it('Archiv-Bindung auf eine nicht fertige oder fehlende Datei zählt nicht', () => {
    hydrateDocumentFileStore([fileRef('fr-png', 'image/png'), fileRef('fr-halb', 'application/pdf', 'pending' as never)], {});
    hydrateDocumentFileRepresentationBindingStore([{ documentId: 'doc-7b', kind: 'archive', fileRefId: 'fr-halb' }] as never);
    expect(findArchivedDocumentPdfFileRefId(doc())).toBeNull();
    hydrateDocumentFileRepresentationBindingStore([{ documentId: 'doc-7b', kind: 'archive', fileRefId: 'fr-gibt-es-nicht' }] as never);
    expect(findArchivedDocumentPdfFileRefId(doc())).toBeNull();
    expect(findArchivedDocumentPdfFileRefId(doc({ fileRefId: undefined }))).toBeNull();
  });

  it('eigener Geschäftsbrief (linkedLetterId) ist letter, auch als Schriftverkehr klassifiziert', () => {
    expect(resolveArchivedDocumentDeliveryKind({ classifiedKind: 'schriftverkehr', linkedLetterId: 'l-1' })).toBe('letter');
    expect(resolveArchivedDocumentDeliveryKind({ classifiedKind: 'schriftverkehr' })).toBe('other');
    expect(resolveArchivedDocumentDeliveryKind({ classifiedKind: 'angebot' })).toBe('offer');
  });

  it('kanonischer Anhangsname: serverkonform, lesbar, ohne Pfad', () => {
    const serverRegel = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.pdf$/;
    const faelle: Array<[Partial<CompanyDocument>, string]> = [
      [{ title: 'Brief – Müller Straße' }, 'Brief - Mueller Strasse.pdf'],
      [{ title: 'AN-2026-0001 – Angebot' }, 'AN-2026-0001 - Angebot.pdf'],
      [{ title: 'bericht.PDF' }, 'bericht.pdf'],
      [{ title: '' , originalFileName: '' }, 'Dokument.pdf'],
    ];
    for (const [input, erwartet] of faelle) {
      const name = buildArchivedDocumentAttachmentFilename({ title: '', originalFileName: '', ...input } as CompanyDocument);
      expect(name).toBe(erwartet);
      expect(name).toMatch(serverRegel);
    }
    for (const boese of ['../../etc/passwd', '..\\..\\windows\\system32', '/absolut/pfad', '....//x']) {
      const name = buildArchivedDocumentAttachmentFilename({ title: boese } as CompanyDocument);
      expect(name, boese).not.toMatch(/[/\\]/);
      expect(name, boese).toMatch(serverRegel);
    }
  });
});

describe('07B — RPC-Vertrag des Clients', () => {
  const input = (overrides: Partial<CreateDocumentDeliveryInput> = {}): CreateDocumentDeliveryInput => ({
    workspaceId: WS,
    clientDeliveryId: 'cd-7b',
    identity: { kind: 'invoice', clientInvoiceId: 'inv-1' },
    recipientEmail: 'kunde@example.invalid',
    subject: 'S',
    bodyText: 'B',
    attachment: { storagePath: `${WS}/invoice-inv-1/${'a'.repeat(64)}.pdf`, sha256: 'a'.repeat(64), sizeBytes: 10, filename: 'R.pdf' },
    provider: 'stub',
    ...overrides,
  });

  it('der bestätigte Neuversuch wird nur mitgeschickt, wenn er gesetzt ist', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'x' } }));
    await rpcCreateWorkspaceDocumentDelivery(input(), { rpc } as never);
    expect(rpc.mock.calls[0]![1]).not.toHaveProperty('p_confirm_uncertain_retry');
    await rpcCreateWorkspaceDocumentDelivery(input({ retryOfDeliveryId: 'd-u', confirmUncertainRetry: true }), { rpc } as never);
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_retry_of_delivery_id: 'd-u', p_confirm_uncertain_retry: true });
  });

  it('Serverfehler werden verständlich eingeordnet, nie roh', async () => {
    const fehler = async (message: string) =>
      rpcCreateWorkspaceDocumentDelivery(input(), { rpc: vi.fn(async () => ({ data: null, error: { message } })) } as never);
    expect(await fehler('Versandlimit erreicht: bitte in einigen Minuten erneut versuchen')).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(await fehler('Erneuter Versand zu diesem unklaren Versuch wurde bereits angelegt')).toMatchObject({ ok: false, error: 'uncertain_retry_exists' });
    expect(await fehler('Erneuter Versand nicht moeglich: Versandstatus unklar')).toMatchObject({ ok: false, error: 'uncertain_pending' });
  });

  it('Migration: der Vertrag des Servers enthält Claim, Recovery, Bestätigung und Grenze', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261010120000_workspace_document_delivery_send_hardening.sql'), 'utf8');
    expect(sql).toContain("and status = 'queued'\n    and row_version = p_expected_row_version");
    expect(sql).toContain('grant execute on function public.claim_workspace_document_delivery_for_send(uuid, bigint) to service_role;');
    expect(sql).toContain("error_code = 'send_interrupted'");
    expect(sql).toContain('greatest(coalesce(p_stale_after_seconds, 600), 120)');
    expect(sql).toContain("if not coalesce(p_confirm_uncertain_retry, false) then");
    expect(sql).toContain("raise exception 'Versandlimit erreicht");
    expect(sql).toContain("'senderDisplayName', v_company->>'senderDisplayName'");
    expect(sql).toContain("'replyToEmail', v_company->>'replyToEmail'");
    // Kein automatischer Neuversand: die Recovery setzt nie wieder queued.
    expect(sql).not.toMatch(/set\s+status\s*=\s*'queued'/);
  });
});

describe('07B — Orchestrator', () => {
  it('ein Neuversuch nach unknown trägt die Bestätigung nur mit Bezug auf den unklaren Versuch', () => {
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    const mitBezug = orchestrator.createSendDraft({ identity: { kind: 'invoice', clientInvoiceId: 'inv-1' }, vorgangId: null, recipientEmail: 'a@b.invalid', subject: 'S', bodyText: 'B', retryOfDeliveryId: 'd-u', confirmUncertainRetry: true });
    expect(mitBezug.confirmUncertainRetry).toBe(true);
    const ohneBezug = orchestrator.createSendDraft({ identity: { kind: 'invoice', clientInvoiceId: 'inv-1' }, vorgangId: null, recipientEmail: 'a@b.invalid', subject: 'S', bodyText: 'B', confirmUncertainRetry: true });
    expect(ohneBezug.confirmUncertainRetry).toBeUndefined();
  });

  it('„Status prüfen": nur ein sending-Versuch fragt den Server (der nie neu sendet); sonst nur Historie', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    const client = { rpc: vi.fn(async () => ({ data: [], error: null })) } as never;
    const invokeSend = vi.fn(async () => ({ status: 200, body: { ok: true, action: 'in_progress' as const } }));

    await orchestrator.checkDeliveryStatus({ delivery: delivery({ status: 'sending', clientDeliveryId: 'cd-s' }) }, { client, invokeSend });
    expect(invokeSend).toHaveBeenCalledWith({ workspaceId: WS, clientDeliveryId: 'cd-s' });

    await orchestrator.checkDeliveryStatus({ delivery: delivery({ status: 'unknown' }) }, { client, invokeSend });
    await orchestrator.checkDeliveryStatus({ delivery: delivery({ status: 'failed' }) }, { client, invokeSend });
    expect(invokeSend).toHaveBeenCalledTimes(1);
  });
});
