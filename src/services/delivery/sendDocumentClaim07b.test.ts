/**
 * E-MAIL-07B — Versandkern: Sende-Claim, Parallelversand, hängender Claim,
 * Testempfänger-Schutz, Absendername und Antwortadresse.
 *
 * Die „Datenbank" ist ein kleiner In-Memory-Fake mit genau der Semantik der
 * Migration 20261010120000: Der Claim ist ein Vergleich-und-Setzen auf Status
 * **und** Version; wer ihn verliert, bekommt die aktuelle Zeile zurück. Die
 * echte SQL-Semantik (Zeilensperre, zwei Sitzungen) prüft
 * `supabase/tests/document_delivery_send_hardening_07b.sql`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStubEmailProvider } from '../../../supabase/functions/_shared/emailProvider';
import {
  STALE_SENDING_CLAIM_SECONDS,
  resolveCompanySenderIdentity,
  resolveSenderIdentity,
  resolveTestRecipientAllowlist,
  runSendDocument,
  type CompanyContext,
  type DeliveryRow,
  type InvoiceContext,
  type ReplyToResolution,
  type SendDocumentDeps,
  type TestRecipientAllowlist,
} from '../../../supabase/functions/_shared/sendDocumentCore';

const WS = '00000000-0000-4000-8000-0000000007b0';
const SENDER = 'rechnung@send.officetakt.de';
const PDF = new TextEncoder().encode('%PDF-1.4 07b-document');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function invoiceRow(overrides: Partial<DeliveryRow> = {}): Promise<DeliveryRow> {
  const sha = await sha256Hex(PDF);
  return {
    id: 'd-7b',
    workspace_id: WS,
    client_delivery_id: 'cd-7b',
    document_kind: 'invoice',
    linked_invoice_id: 'inv-1',
    recipient_email: 'kunde@example.invalid',
    subject: 'Rechnung 2026-0001',
    body_text: 'Anbei.',
    attachment_storage_path: `${WS}/invoice-inv-1/${sha}.pdf`,
    attachment_sha256: sha,
    attachment_size_bytes: PDF.byteLength,
    attachment_filename: 'Rechnung_2026-0001.pdf',
    attachment_mime_type: 'application/pdf',
    provider: 'stub',
    provider_message_id: null,
    status: 'queued',
    row_version: 1,
    error_category: null,
    error_code: null,
    error_message_safe: null,
    ...overrides,
  };
}

const INVOICE: InvoiceContext = {
  client_invoice_id: 'inv-1',
  invoice_number: '2026-0001',
  invoice_status: 'vorbereitet',
  cancelled_at: null,
  cancellation_kind: null,
  correction_document_id: null,
  sent_source: null,
  sent_delivery_id: null,
  company_snapshot: { companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid' },
};

interface FakeOptions {
  company?: CompanyContext | null;
  /** EINRICHTUNG-01 (AP6; E18) — Antwort des Servers auf die Frage nach der Antwortadresse. */
  replyTo?: ReplyToResolution;
  allowlist?: TestRecipientAllowlist;
  /** Provider-Aufruf künstlich verzögern (Parallelität sichtbar machen). */
  providerDelayMs?: number;
  /** Simuliert den Absturz beim Speichern der Annahme. */
  failMarkAccepted?: boolean;
  /** Der Server hält `sending` für hängend. */
  staleClaim?: boolean;
  providerResult?: 'accept' | 'timeout' | 'reject';
}

/** In-Memory-Datenbank mit der Claim-Semantik der Migration. */
function fakeDb(initial: DeliveryRow, options: FakeOptions = {}) {
  let row: DeliveryRow = { ...initial };
  const calls = { sent: [] as Array<{ from: { email: string; name: string }; replyTo: { email: string; name?: string }; to: { email: string } }>, claims: 0, claimsWon: 0 };
  const stub = createStubEmailProvider();

  const deps: SendDocumentDeps = {
    senderEmail: SENDER,
    testRecipientAllowlist: options.allowlist,
    userCanWrite: vi.fn(async () => true),
    // Jeder Aufruf bekommt seine eigene Momentaufnahme — wie ein SELECT.
    loadDelivery: vi.fn(async () => ({ delivery: { ...row }, invoice: INVOICE, company: options.company ?? null })),
    // EINRICHTUNG-01 (AP6; E18) — die Antwortadresse bestimmt der Server bei jedem Versand.
    resolveReplyTo: vi.fn(async () => options.replyTo ?? ({ ok: true, email: 'inhaber@betrieb.invalid', source: 'owner_login' } as const)),
    downloadAttachment: vi.fn(async () => PDF),
    sha256Hex,
    provider: {
      provider: 'stub',
      async sendTransactionalEmail(input) {
        calls.sent.push(input as never);
        if (options.providerDelayMs) await new Promise((resolve) => setTimeout(resolve, options.providerDelayMs));
        if (options.providerResult === 'timeout') {
          return { accepted: false, handoffUncertain: true, errorCategory: 'network', errorCode: 'timeout', errorMessageSafe: 'Zeitüberschreitung' };
        }
        if (options.providerResult === 'reject') {
          return { accepted: false, handoffUncertain: false, errorCategory: 'recipient', errorCode: 'invalid', errorMessageSafe: 'Abgelehnt' };
        }
        return stub.sendTransactionalEmail(input);
      },
    },
    claim: vi.fn(async (id, expected) => {
      calls.claims += 1;
      if (row.id === id && row.status === 'queued' && row.row_version === expected) {
        row = { ...row, status: 'sending', row_version: row.row_version + 1 };
        calls.claimsWon += 1;
        return { claimed: true, delivery: { ...row } };
      }
      return { claimed: false, delivery: { ...row } };
    }),
    resolveStaleClaim: vi.fn(async () => {
      if (row.status === 'sending' && options.staleClaim) {
        row = { ...row, status: 'unknown', error_category: 'unknown', error_code: 'send_interrupted', row_version: row.row_version + 1 };
        return { resolved: true, delivery: { ...row } };
      }
      return { resolved: false, delivery: { ...row } };
    }),
    markAccepted: vi.fn(async (id, messageId, expected) => {
      if (options.failMarkAccepted) throw new Error('accept: netzwerk');
      if (row.row_version !== expected) throw new Error('row_version veraltet');
      row = { ...row, status: 'provider_accepted', provider_message_id: messageId, row_version: row.row_version + 1 };
      return { delivery: { ...row }, coupling: 'linked' };
    }),
    markStatus: vi.fn(async (id, status, error, expected) => {
      if (row.row_version !== expected) throw new Error('row_version veraltet');
      row = { ...row, status, error_category: error.category, error_code: error.code, error_message_safe: error.message, row_version: row.row_version + 1 };
      return { ...row };
    }),
    log: () => {},
  };
  return { deps, calls, current: () => row };
}

const send = (deps: SendDocumentDeps) => runSendDocument({ userId: 'u-1', workspaceId: WS, clientDeliveryId: 'cd-7b' }, deps);

/* ================================================================== */

describe('07B — Sende-Claim', () => {
  it('A: normaler Versand geht über den Claim: queued -> sending -> provider_accepted, genau ein Provider-Aufruf', async () => {
    const db = fakeDb(await invoiceRow());
    const outcome = await send(db.deps);
    expect(outcome).toMatchObject({ ok: true, action: 'sent' });
    expect(db.calls.claimsWon).toBe(1);
    expect(db.calls.sent).toHaveLength(1);
    expect(db.current()).toMatchObject({ status: 'provider_accepted', row_version: 3 });
  });

  it('B/C/D: zwei parallele Aufrufe auf dieselbe Delivery — genau ein Provider-Aufruf, der zweite sendet nicht', async () => {
    const db = fakeDb(await invoiceRow(), { providerDelayMs: 20 });
    const [erster, zweiter] = await Promise.all([send(db.deps), send(db.deps)]);

    expect(db.calls.claims).toBe(2);
    expect(db.calls.claimsWon).toBe(1);
    expect(db.calls.sent).toHaveLength(1);
    const actions = [erster, zweiter].map((o) => (o.ok ? o.action : o.error)).sort();
    // Der Verlierer bekommt einen ungefährlichen Zustand: der Versand läuft (noch) — keine zweite Mail, kein Fehler.
    expect(actions).toEqual(['in_progress', 'sent']);
    expect(db.current().status).toBe('provider_accepted');
  });

  it('E: Replay nach provider_accepted sendet nicht erneut und claimt nicht', async () => {
    const db = fakeDb(await invoiceRow({ status: 'provider_accepted', provider_message_id: 'msg-1', row_version: 3 }));
    const outcome = await send(db.deps);
    expect(outcome).toMatchObject({ ok: true, action: 'replayed' });
    expect(db.calls.claims).toBe(0);
    expect(db.calls.sent).toHaveLength(0);
  });

  it('F: veraltete Version (ein anderer Aufruf war schneller) — kein Claim, keine Mail', async () => {
    const db = fakeDb(await invoiceRow());
    // Die Zeile ändert sich zwischen Laden und Claim (ein paralleler Aufruf hat bereits geclaimt).
    const originalLoad = db.deps.loadDelivery;
    db.deps.loadDelivery = vi.fn(async (ws, id) => {
      const loaded = await originalLoad(ws, id);
      await db.deps.claim(loaded!.delivery.id, loaded!.delivery.row_version);
      return loaded;
    });
    const outcome = await send(db.deps);
    expect(outcome).toMatchObject({ ok: true, action: 'in_progress' });
    expect(db.calls.sent).toHaveLength(0);
  });

  it('F2: ungültiger Zustand (prepared) wird weder geclaimt noch gesendet', async () => {
    const db = fakeDb(await invoiceRow({ status: 'prepared' }));
    expect(await send(db.deps)).toEqual({ ok: false, error: 'invalid_state' });
    expect(db.calls.claims).toBe(0);
    expect(db.calls.sent).toHaveLength(0);
  });

  it('Provider-Fehler nach dem Claim wird mit der geclaimten Version gespeichert (sending -> failed / unknown)', async () => {
    const rejected = fakeDb(await invoiceRow(), { providerResult: 'reject' });
    expect(await send(rejected.deps)).toMatchObject({ ok: true, action: 'failed' });
    expect(rejected.current()).toMatchObject({ status: 'failed', row_version: 3 });

    const timeout = fakeDb(await invoiceRow(), { providerResult: 'timeout' });
    expect(await send(timeout.deps)).toMatchObject({ ok: true, action: 'unknown_pending' });
    expect(timeout.current()).toMatchObject({ status: 'unknown', row_version: 3 });
  });

  it('Prüffehler vor dem Claim lassen die Delivery nie in sending (Anhang fehlt -> failed ohne Claim)', async () => {
    const db = fakeDb(await invoiceRow());
    db.deps.downloadAttachment = vi.fn(async () => null);
    expect(await send(db.deps)).toMatchObject({ ok: true, action: 'failed' });
    expect(db.calls.claims).toBe(0);
    expect(db.current().status).toBe('failed');
  });
});

describe('07B — Absturz nach dem Claim / hängender Claim', () => {
  it('Absturz beim Speichern der Annahme: Delivery bleibt sending, ein erneuter Aufruf sendet NICHT', async () => {
    const db = fakeDb(await invoiceRow(), { failMarkAccepted: true });
    await expect(send(db.deps)).rejects.toThrow('accept');
    expect(db.calls.sent).toHaveLength(1);
    expect(db.current().status).toBe('sending');

    // „Fortsetzen" / „Status prüfen": solange der Claim frisch ist -> in_progress, keine zweite Mail.
    const again = await send(db.deps);
    expect(again).toMatchObject({ ok: true, action: 'in_progress' });
    expect(db.calls.sent).toHaveLength(1);
  });

  it('hängender Claim wird unknown (send_interrupted) — nie ein zweiter Provider-Aufruf', async () => {
    const db = fakeDb(await invoiceRow({ status: 'sending', row_version: 2 }), { staleClaim: true });
    const outcome = await send(db.deps);
    expect(outcome).toMatchObject({ ok: true, action: 'unknown_pending', delivery: { status: 'unknown', errorCode: 'send_interrupted' } });
    expect(db.deps.resolveStaleClaim).toHaveBeenCalledWith('d-7b', STALE_SENDING_CLAIM_SECONDS);
    expect(db.calls.sent).toHaveLength(0);
    expect(db.calls.claims).toBe(0);
  });

  it('die Frist liegt deutlich über Provider-Timeout und Funktionslaufzeit', () => {
    expect(STALE_SENDING_CLAIM_SECONDS).toBeGreaterThanOrEqual(600);
  });

  it('unknown bleibt ohne neuen Versuch unknown — der Kern sendet nicht', async () => {
    const db = fakeDb(await invoiceRow({ status: 'unknown', row_version: 3 }));
    expect(await send(db.deps)).toMatchObject({ ok: true, action: 'unknown_pending' });
    expect(db.calls.sent).toHaveLength(0);
    expect(db.calls.claims).toBe(0);
  });
});

describe('07B — Testempfänger-Schutz (MAIL_TEST_RECIPIENT_ALLOWLIST)', () => {
  it('Konfiguration: leer = aus; kommagetrennt, normalisiert, dedupliziert; unbrauchbar = invalid', () => {
    expect(resolveTestRecipientAllowlist(undefined)).toEqual({ mode: 'off' });
    expect(resolveTestRecipientAllowlist('   ')).toEqual({ mode: 'off' });
    expect(resolveTestRecipientAllowlist(' Test@Example.invalid , test@example.invalid,zweit@example.invalid ')).toEqual({
      mode: 'on',
      recipients: ['test@example.invalid', 'zweit@example.invalid'],
    });
    expect(resolveTestRecipientAllowlist(',,')).toEqual({ mode: 'invalid' });
    expect(resolveTestRecipientAllowlist('kein-empfaenger')).toEqual({ mode: 'invalid' });
    expect(resolveTestRecipientAllowlist('ok@example.invalid, kaputt')).toEqual({ mode: 'invalid' });
  });

  it('aktiv: freigegebene Adresse wird gesendet', async () => {
    const db = fakeDb(await invoiceRow(), { allowlist: { mode: 'on', recipients: ['kunde@example.invalid'] } });
    expect(await send(db.deps)).toMatchObject({ ok: true, action: 'sent' });
    expect(db.calls.sent).toHaveLength(1);
  });

  it('aktiv: jede andere Adresse wird fail-closed abgelehnt, ohne Claim und ohne Provider', async () => {
    const db = fakeDb(await invoiceRow({ recipient_email: 'echter.kunde@example.invalid' }), {
      allowlist: { mode: 'on', recipients: ['kunde@example.invalid'] },
    });
    const outcome = await send(db.deps);
    expect(outcome).toMatchObject({ ok: true, action: 'failed', delivery: { status: 'failed', errorCategory: 'recipient', errorCode: 'test_recipient_not_allowed' } });
    expect(db.calls.claims).toBe(0);
    expect(db.calls.sent).toHaveLength(0);
  });

  it('fehlkonfiguriert: gar kein Versand', async () => {
    const db = fakeDb(await invoiceRow(), { allowlist: { mode: 'invalid' } });
    expect(await send(db.deps)).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'test_recipient_allowlist_invalid' } });
    expect(db.calls.sent).toHaveLength(0);
  });

  it('aus (Normalbetrieb): jede gültige Adresse wird gesendet', async () => {
    const db = fakeDb(await invoiceRow({ recipient_email: 'irgendwer@example.invalid' }), { allowlist: { mode: 'off' } });
    expect(await send(db.deps)).toMatchObject({ ok: true, action: 'sent' });
  });
});

/*
 * EINRICHTUNG-01 (AP6; E18, K4) — die Antwortadresse bestimmt der Server (`resolve_workspace_reply_to`): die bestätigte
 * Antwortadresse des Betriebs, sonst die bestätigte Anmelde-E-Mail des Inhabers. Die gespeicherte Wunschadresse und die
 * Firmen-E-Mail werden nie verwendet; ohne bestätigte Adresse: kein Versand (`reply_to_unavailable`).
 */
describe('07B — Absendername und Antwortadresse (serverseitig aus dem Workspace)', () => {
  it('eigener Anzeigename erreicht den Provider; Antwortadresse ist die bestätigte des Betriebs — auch beim Rechnungsversand', async () => {
    const db = fakeDb(await invoiceRow(), {
      company: { companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', senderDisplayName: 'Meister Müller', replyToEmail: 'Buero@Betrieb.invalid' },
      replyTo: { ok: true, email: 'buero@betrieb.invalid', source: 'confirmed_reply_to' },
    });
    await send(db.deps);
    expect(db.calls.sent[0].from).toEqual({ email: SENDER, name: 'Meister Müller' });
    expect(db.calls.sent[0].replyTo.email).toBe('buero@betrieb.invalid');
  });

  it('unbestätigte Wunschadresse: Antworten an die bestätigte Anmelde-E-Mail des Inhabers, nie an die Firmen-E-Mail', async () => {
    const db = fakeDb(await invoiceRow(), { company: { companyName: 'Betrieb', email: 'aktuell@betrieb.invalid', senderDisplayName: '', replyToEmail: 'wunsch@betrieb.invalid' } });
    await send(db.deps);
    expect(db.calls.sent[0].from.name).toBe('Betrieb GmbH');
    expect(db.calls.sent[0].replyTo.email).toBe('inhaber@betrieb.invalid');
  });

  it('keine bestätigte Adresse (E-03.11): kein Versand, kein Claim, sichere Meldung mit Weg', async () => {
    const db = fakeDb(await invoiceRow(), { company: { companyName: 'Betrieb', email: 'info@betrieb.invalid', replyToEmail: 'kaputt@' }, replyTo: { ok: false, code: 'reply_to_unavailable' } });
    const outcome = await send(db.deps);
    expect(outcome).toMatchObject({ ok: true, action: 'failed', delivery: { errorCode: 'reply_to_unavailable' } });
    expect(db.calls.sent).toHaveLength(0);
    expect(db.calls.claims).toBe(0);
  });

  it('Resolver: exakte Werte für Rechnung und Dokument', () => {
    expect(resolveSenderIdentity(INVOICE, { senderDisplayName: 'Anzeige', replyToEmail: 'wunsch@betrieb.invalid' }, 'Antwort@Betrieb.invalid')).toEqual({ ok: true, fromName: 'Anzeige', replyTo: 'antwort@betrieb.invalid' });
    expect(resolveSenderIdentity(INVOICE, null, 'inhaber@betrieb.invalid')).toEqual({ ok: true, fromName: 'Betrieb GmbH', replyTo: 'inhaber@betrieb.invalid' });
    expect(resolveSenderIdentity(INVOICE, null, 'x')).toEqual({ ok: false, code: 'reply_to_unavailable' });
    expect(resolveCompanySenderIdentity({ companyName: 'Betrieb', email: 'info@betrieb.invalid', senderDisplayName: 'Anzeige' }, 'inhaber@betrieb.invalid')).toEqual({ ok: true, fromName: 'Anzeige', replyTo: 'inhaber@betrieb.invalid' });
    // Ein ungültiger gespeicherter Anzeigename fällt auf die Ableitung zurück (E-04).
    expect(resolveCompanySenderIdentity({ companyName: 'Betrieb', legalForm: 'GmbH', senderDisplayName: 'info@betrieb.invalid' }, 'inhaber@betrieb.invalid')).toEqual({ ok: true, fromName: 'Betrieb GmbH', replyTo: 'inhaber@betrieb.invalid' });
  });
});
