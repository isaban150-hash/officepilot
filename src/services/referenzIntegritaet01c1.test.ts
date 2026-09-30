/**
 * EINGANG-01C-1 — deterministische Zuordnungskette / Referenzintegrität.
 *
 * P1: Ein einzelner loser Teilstring-Treffer auf eine Rechnungs- oder
 * Auftragsnummer galt als „exact" und wurde bei der Übernahme automatisch als
 * Vorgangszuordnung gespeichert. Diese Tests prüfen die echte Kette:
 * `buildDocumentCaseMatch` → `resolvePrimaryTargetForInboxItem` →
 * `analyzeUploadedDocument` (nextActions) → `executeVorgangAtom`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAbschlagInvoice, createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { buildDocumentCaseMatch } from './documentCaseMatchService';
import { resolvePrimaryTargetForInboxItem } from './documentPrimaryTargetResolver';
import { hydrateDocumentStore } from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { hydrateInvoiceStore } from './invoice/invoiceStore';
import { analyzeUploadedDocument } from './intakeWorkflowService';
import { executeVorgangAtom } from './intakeExecutionAtoms';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore, linkInboxToExistingVorgang, unlinkInboxItemFromVorgang } from './vorgangService';
import * as persistence from './persistenceService';
import { buildInboxItemCloudPayload, mergeInboxItemsFromPull, type CloudInboxRow } from './document/intakeCloudSyncService';
import type { InboxItem, InboxVorgangAssignment, Vorgang, WorkflowExecutionFailure, WorkflowExecutionStepId } from '../types/models';

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

function vorgang(id: string, overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id,
    title: `Vorgang ${id}`,
    customer: `Kunde ${id}`,
    baustelle: `Baustraße ${id}`,
    status: 'in_bearbeitung',
    ...overrides,
  });
}

/** Eigene Ausgangsrechnung im echten Rechnungsspeicher (so liest sie `cloneVorgang`). */
function ownInvoice(vorgangId: string, number: string) {
  return { vorgangId, invoice: createAbschlagInvoice('op-test-1', 1, { id: `inv-${vorgangId}-${number}`, number }) };
}

/** Eingehende Lieferantenrechnung (fremde Nummer, fremder Absender). */
function supplierInvoice(overrides: Partial<InboxItem> = {}, text = ''): InboxItem {
  const { recognizedData, ...rest } = overrides;
  return createAuftragInboxItem({
    id: 'inbox-01c1',
    title: 'Eingangsrechnung Baustoff Meyer',
    documentType: 'eingangsrechnung',
    classifiedKind: 'eingangsrechnung',
    sender: 'Baustoff Meyer GmbH',
    markedAsCompanyDocument: true,
    recognizedData: {
      Lieferant: 'Baustoff Meyer GmbH',
      Betreff: 'Mustermann Sanitär GmbH',
      ...(text ? { _extractedText: text } : {}),
      ...recognizedData,
    },
    ...rest,
  });
}

function nextActionIds(item: InboxItem): string[] {
  hydrateInboxStore([item]);
  return analyzeUploadedDocument(item.id)?.nextActions.filter((a) => a.enabled).map((a) => a.id) ?? [];
}

beforeEach(() => {
  localStorage.clear();
  setTaskStoreForTests([]);
  hydrateCompanyProfileStore(PROFILE);
  hydrateDocumentStore([]);
  hydrateInboxStore([]);
  hydrateInvoiceStore([]);
  hydrateVorgangStore([]);
});

describe('P1 — Reproduktion: lose Nummerntreffer sind kein exact', () => {
  it('P1: Lieferantenrechnung 2026-0012 ≠ eigene Ausgangsrechnung 2026-0012 von Vorgang A', () => {
    hydrateVorgangStore([vorgang('v-a')]);
    hydrateInvoiceStore([ownInvoice('v-a', '2026-0012')]);
    const item = supplierInvoice({ recognizedData: { Rechnungsnummer: '2026-0012' } });

    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).not.toBe('exact');
    expect(match.matchedCaseId).not.toBe('v-a');
    const target = resolvePrimaryTargetForInboxItem(item);
    expect(target.suggestedVorgang).toBeNull();
    expect(nextActionIds(item)).not.toContain('link_vorgang');
  });

  it('P1: die Übernahme verknüpft bei diesem Treffer nichts', () => {
    hydrateVorgangStore([vorgang('v-a')]);
    hydrateInvoiceStore([ownInvoice('v-a', '2026-0012')]);
    const item = supplierInvoice({ recognizedData: { Rechnungsnummer: '2026-0012' } });
    hydrateInboxStore([item]);
    const workflow = analyzeUploadedDocument(item.id)!;
    const success: WorkflowExecutionStepId[] = [];
    const failed: WorkflowExecutionFailure[] = [];
    executeVorgangAtom(item, workflow, {}, success, failed);
    expect(success).not.toContain('link_vorgang');
    expect(getInboxItemById(item.id)?.vorgangId).toBeUndefined();
    expect(getInboxItemById(item.id)?.vorgangLinkStatus).toBeUndefined();
  });

  it('T1: kurzer Rechnungsnummer-Teilstring (12 in RE-2026-0012) → nicht exact', () => {
    hydrateVorgangStore([vorgang('v-a')]);
    hydrateInvoiceStore([ownInvoice('v-a', 'RE-2026-0012')]);
    const match = buildDocumentCaseMatch(supplierInvoice({ recognizedData: { Rechnungsnummer: '12' } }));
    expect(match.matchStatus).not.toBe('exact');
  });

  it('T2: loser Auftragsnummer-Teilstring (Wort-Fang „des") → nicht exact', () => {
    hydrateVorgangStore([vorgang('v-a', { title: 'Dachsanierung des Gebäudes' })]);
    const item = createAuftragInboxItem({
      id: 'inbox-t2',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
      recognizedData: { Auftragsnummer: 'des' },
    });
    expect(buildDocumentCaseMatch(item).matchStatus).not.toBe('exact');
  });

  it('T15: früherer Beispielwert RE-2026-0001 wird keine sichere Referenz', () => {
    hydrateVorgangStore([vorgang('v-a')]);
    hydrateInvoiceStore([ownInvoice('v-a', 'RE-2026-0001')]);
    const match = buildDocumentCaseMatch(supplierInvoice({ recognizedData: { Rechnungsnummer: 'RE-2026-0001' } }));
    expect(match.matchStatus).not.toBe('exact');
  });

  it('Hintertür: Nummerngewicht + gleicher Kundenname ergibt kein exact', () => {
    hydrateVorgangStore([vorgang('v-a', { customer: 'Baustoff Meyer GmbH' })]);
    hydrateInvoiceStore([ownInvoice('v-a', '2026-0012')]);
    const item = supplierInvoice({ recognizedData: { Rechnungsnummer: '2026-0012', Kunde: 'Baustoff Meyer GmbH' } });
    expect(buildDocumentCaseMatch(item).matchStatus).not.toBe('exact');
  });
});

describe('Deterministische eigene Referenzen', () => {
  it('T3: AU-2026-0012 ist nicht 2026-0012', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' })]);
    const onlyDigits = supplierInvoice({}, 'Lieferung zu Ihrer Bestellung 2026-0012');
    expect(buildDocumentCaseMatch(onlyDigits).matchStatus).not.toBe('exact');
    hydrateVorgangStore([vorgang('v-a', { orderNumber: '2026-0012' })]);
    const withPrefix = supplierInvoice({}, 'Lieferung zu Ihrer Bestellung AU-2026-0012');
    expect(buildDocumentCaseMatch(withPrefix).matchStatus).not.toBe('exact');
  });

  it('T5: eindeutige eigene Auftragsnummer im Dokument → exact mit Referenztyp order', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' }), vorgang('v-b', { orderNumber: 'AU-2026-0013' })]);
    const item = supplierInvoice({ recognizedData: { Rechnungsnummer: 'LM-88231' } }, 'Rechnung LM-88231\nIhr Auftrag: AU-2026-0012.\nMaterial laut Lieferschein');
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.matchedCaseId).toBe('v-a');
    expect(match.reference).toEqual({ kind: 'order', value: 'AU-2026-0012' });
    expect(nextActionIds(item)).toContain('link_vorgang');
  });

  it('T5b: Satzzeichen und Gedankenstrich-Varianten um die Nummer stören nicht', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' })]);
    const item = supplierInvoice({}, 'Bezug: Nr.AU‑2026‑0012/Teil 2');
    expect(buildDocumentCaseMatch(item).reference).toEqual({ kind: 'order', value: 'AU-2026-0012' });
  });

  it('T6: eindeutige Angebotsnummer eines angenommenen Angebots → exact mit Referenztyp offer', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0020', sourceOfferNumber: 'AN-2026-0007' })]);
    const item = supplierInvoice({}, 'Bezug: Angebot AN-2026-0007 vom 01.09.2026');
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.reference).toEqual({ kind: 'offer', value: 'AN-2026-0007' });
  });

  it('T4: eigene Rechnungsnummer exakt → nur Vorschlag (kein Kundenbeweis am Eingang)', () => {
    hydrateVorgangStore([vorgang('v-a')]);
    hydrateInvoiceStore([ownInvoice('v-a', 'RE-2026-0044')]);
    const item = supplierInvoice({ classifiedKind: 'brief', documentType: 'brief' }, 'Zahlungsavis zu Ihrer Rechnung RE-2026-0044');
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).not.toBe('exact');
    expect(match.candidates.map((candidate) => candidate.caseId)).toContain('v-a');
    expect(resolvePrimaryTargetForInboxItem(item).suggestedVorgang).toBeNull();
  });

  it('Eigene Rechnungsnummer des Absenders (Rechnungsnummer-Feld) zählt nie als Auftragsreferenz', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' })]);
    const item = supplierInvoice({ recognizedData: { Rechnungsnummer: 'AU-2026-0012' } }, 'Rechnung AU-2026-0012');
    expect(buildDocumentCaseMatch(item).matchStatus).not.toBe('exact');
  });
});

describe('Mehrdeutigkeit — fail-closed', () => {
  it('T7: dieselbe Nummer ist Auftrag von A und Rechnung von B → multiple, keine Auto-Zuordnung', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' }), vorgang('v-b')]);
    hydrateInvoiceStore([ownInvoice('v-b', 'AU-2026-0012')]);
    const item = supplierInvoice({}, 'Bezug AU-2026-0012');
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('multiple');
    expect(match.matchedCaseId).toBeNull();
    expect(nextActionIds(item)).not.toContain('link_vorgang');
  });

  it('T8/T11: zwei eigene Referenzen auf verschiedene Vorgänge → multiple', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' }), vorgang('v-b', { orderNumber: 'AU-2026-0034' })]);
    const item = supplierInvoice({ recognizedData: { Auftragsnummer: 'AU-2026-0012' } }, 'Nachtrag zu AU-2026-0034');
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('multiple');
    expect(match.candidates.map((c) => c.caseId).sort()).toEqual(['v-a', 'v-b']);
    expect(nextActionIds(item)).not.toContain('link_vorgang');
  });

  it('Referenz auf A, aber starke Namens-/Baustellenregel für B → multiple', () => {
    hydrateVorgangStore([
      vorgang('v-a', { orderNumber: 'AU-2026-0012' }),
      vorgang('v-b', { customer: 'Isobautec GmbH', baustelle: 'Möhnetal 55' }),
    ]);
    const item = createAuftragInboxItem({
      id: 'inbox-conflict',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
      recognizedData: { Auftraggeber: 'Isobautec GmbH', Baustelle: 'Möhnetal 55', _extractedText: 'Werkvertrag zu AU-2026-0012' },
    });
    expect(buildDocumentCaseMatch(item).matchStatus).toBe('multiple');
  });

  it('T9: unscharfer Treffer (nur Kunde) bleibt Vorschlag', () => {
    hydrateVorgangStore([vorgang('v-a', { customer: 'Baustoff Meyer GmbH' })]);
    const item = supplierInvoice();
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).not.toBe('exact');
    expect(nextActionIds(item)).not.toContain('link_vorgang');
  });

  it('T10: bestätigte menschliche Zuordnung bleibt vorrangig — auch gegen eine Referenz', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' }), vorgang('v-c')]);
    const item = supplierInvoice({ vorgangId: 'v-c', vorgangTitle: 'Vorgang v-c', vorgangLinkStatus: 'linked' }, 'Bezug AU-2026-0012');
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.matchedCaseId).toBe('v-c');
    expect(match.reasons).toContain('known_link');
  });

  it('gelöschte/fehlende Vorgänge liefern keine Referenz', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012', sync: { updatedAt: 'x', version: 2, deleted: true } as Vorgang['sync'] })]);
    expect(buildDocumentCaseMatch(supplierInvoice({}, 'Bezug AU-2026-0012')).matchStatus).toBe('none');
  });
});

describe('01A/01B bleiben — Zuordnungsgrund', () => {
  it('Namens-/Baustellenregel (Kunde + Baustelle) ist nur noch Vorschlag (P1-A)', () => {
    hydrateVorgangStore([vorgang('v-site', { customer: 'Isobautec GmbH', baustelle: 'Möhnetal 55' })]);
    const item = createAuftragInboxItem({
      id: 'inbox-site',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
      recognizedData: { Auftraggeber: 'Isobautec GmbH', Baustelle: 'Möhnetal 55' },
    });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('likely');
    expect(match.matchedCaseId).toBe('v-site');
    expect(match.reference).toBeUndefined();
    expect(nextActionIds(item)).not.toContain('link_vorgang');
  });

  it('T13/T14: Mail-Anhang — Herkunft bleibt Herkunft, die Dokumentreferenz entscheidet', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' }), vorgang('v-mail')]);
    const item = supplierInvoice(
      {
        id: 'inbox-mail-att-1',
        importSource: 'email',
        emailOrigin: { messageId: 'msg-1', attachmentId: 'att-1', position: 1, sha256: 'a'.repeat(64), importedAt: '2026-09-30T10:00:00.000Z' },
      },
      'Rechnung zu Ihrem Auftrag AU-2026-0012',
    );
    const match = buildDocumentCaseMatch(item);
    expect(match.matchedCaseId).toBe('v-a');
    expect(item.vorgangId).toBeUndefined();
  });

  it('T16: deterministische Übernahme speichert den Zuordnungsgrund', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' })]);
    const item = supplierInvoice({}, 'Ihr Auftrag AU-2026-0012');
    hydrateInboxStore([item]);
    const workflow = analyzeUploadedDocument(item.id)!;
    const success: WorkflowExecutionStepId[] = [];
    const failed: WorkflowExecutionFailure[] = [];
    executeVorgangAtom(item, workflow, {}, success, failed);
    expect(success).toContain('link_vorgang');
    const linked = getInboxItemById(item.id)!;
    expect(linked.vorgangId).toBe('v-a');
    expect(linked.vorgangLinkStatus).toBe('linked');
    expect(linked.vorgangAssignment).toMatchObject({
      source: 'deterministic_reference',
      reference: { kind: 'order', value: 'AU-2026-0012' },
    });
    expect(typeof linked.vorgangAssignment?.decidedAt).toBe('string');
  });
});

describe('P1-A — Namen, Baustelle, Projekt, Absender sind nie exact', () => {
  function applyVorgangStep(item: InboxItem) {
    hydrateInboxStore([item]);
    const workflow = analyzeUploadedDocument(item.id)!;
    const success: WorkflowExecutionStepId[] = [];
    const failed: WorkflowExecutionFailure[] = [];
    executeVorgangAtom(item, workflow, {}, success, failed);
    return { success, linked: getInboxItemById(item.id) };
  }

  it('T12: Teilstring Kunde („Müller" ⊂ „Familie Müller") + Baustelle („Berlin" ⊂ Adresse) → nicht exact', () => {
    hydrateVorgangStore([vorgang('v-mueller', { customer: 'Familie Müller', baustelle: 'Hauptstr. 12, Berlin' })]);
    const item = createAuftragInboxItem({
      id: 'inbox-t12',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
      recognizedData: { Auftraggeber: 'Müller', Baustelle: 'Berlin' },
    });
    expect(buildDocumentCaseMatch(item).matchStatus).not.toBe('exact');
    const { success, linked } = applyVorgangStep(item);
    expect(success).not.toContain('link_vorgang');
    expect(linked?.vorgangId).toBeUndefined();
  });

  it('T13: Projekt + Absender (Projekt 40 + „Lieferant" 10) → nicht exact', () => {
    hydrateVorgangStore([vorgang('v-nord', { title: 'Dachsanierung Nord', customer: 'Nordbau GmbH' })]);
    const item = supplierInvoice({
      classifiedKind: 'brief',
      documentType: 'brief',
      sender: 'Nordbau GmbH',
      recognizedData: { Bauvorhaben: 'Dachsanierung Nord', Lieferant: 'Nordbau GmbH' },
    });
    expect(buildDocumentCaseMatch(item).matchStatus).not.toBe('exact');
    expect(nextActionIds(item)).not.toContain('link_vorgang');
  });

  it('T14: Stammkunde + gleiche Adresse + neuer Vertrag → keine automatische Zuordnung zum alten Vorgang', () => {
    hydrateVorgangStore([vorgang('v-alt', { title: 'Badsanierung 2025', customer: 'Isobautec GmbH', baustelle: 'Möhnetal 55' })]);
    const item = createAuftragInboxItem({
      id: 'inbox-t14',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
      recognizedData: { Auftraggeber: 'Isobautec GmbH', Baustelle: 'Möhnetal 55', Bauvorhaben: 'Küchenumbau' },
    });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).not.toBe('exact');
    expect(match.candidates.map((candidate) => candidate.caseId)).toContain('v-alt');
    const { success, linked } = applyVorgangStep(item);
    expect(success).not.toContain('link_vorgang');
    expect(linked?.vorgangId).toBeUndefined();
    expect(linked?.vorgangLinkStatus).toBeUndefined();
  });

  it('T15: nackte vorgangId ohne linked/created → kein known_link, keine stille Bestätigung', () => {
    hydrateVorgangStore([vorgang('v-alt')]);
    const item = supplierInvoice({ vorgangId: 'v-alt', vorgangTitle: 'Vorgang v-alt' });
    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).not.toBe('exact');
    expect(match.reasons).not.toContain('known_link');
    const { success, linked } = applyVorgangStep(item);
    expect(success).not.toContain('link_vorgang');
    expect(linked?.vorgangLinkStatus).toBeUndefined();
    expect(linked?.vorgangAssignment).toBeUndefined();
  });

  it('T16: bestätigte Verknüpfung (linked/created) bleibt exact über known_link', () => {
    hydrateVorgangStore([vorgang('v-alt')]);
    for (const status of ['linked', 'created'] as const) {
      const match = buildDocumentCaseMatch(supplierInvoice({ vorgangId: 'v-alt', vorgangTitle: 'Vorgang v-alt', vorgangLinkStatus: status }));
      expect(match.matchStatus).toBe('exact');
      expect(match.reasons).toContain('known_link');
    }
  });
});

describe('Zuordnungsgrund — Rollback und Sync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const assignment: InboxVorgangAssignment = {
    source: 'deterministic_reference',
    reference: { kind: 'order', value: 'AU-2026-0012' },
    decidedAt: '2026-09-30T10:00:00.000Z',
  };

  it('T18: fehlgeschlagener Unlink stellt Link UND Zuordnungsgrund exakt wieder her', () => {
    hydrateVorgangStore([vorgang('v-a', { orderNumber: 'AU-2026-0012' })]);
    hydrateInboxStore([supplierInvoice()]);
    expect(linkInboxToExistingVorgang(getInboxItemById('inbox-01c1')!, 'v-a', assignment)).not.toBeNull();
    const before = getInboxItemById('inbox-01c1')!;
    expect(before.vorgangAssignment).toEqual(assignment);

    vi.spyOn(persistence, 'persistAll').mockReturnValue({ success: false } as ReturnType<typeof persistence.persistAll>);
    const result = unlinkInboxItemFromVorgang('inbox-01c1');
    expect(result.success).toBe(false);

    const after = getInboxItemById('inbox-01c1')!;
    expect(after.vorgangId).toBe(before.vorgangId);
    expect(after.vorgangTitle).toBe(before.vorgangTitle);
    expect(after.vorgangLinkStatus).toBe(before.vorgangLinkStatus);
    expect(after.vorgangAssignment).toEqual(assignment);
  });

  it('T19: vorgangAssignment bleibt über Cloud-Payload und Pull erhalten', () => {
    const item = supplierInvoice({ vorgangId: 'v-a', vorgangTitle: 'Vorgang v-a', vorgangLinkStatus: 'linked', vorgangAssignment: assignment });
    const payload = buildInboxItemCloudPayload(item);
    expect(payload.vorgangAssignment).toEqual(assignment);
    const row: CloudInboxRow = {
      client_inbox_id: item.id, status: item.status, vorgang_link_status: 'linked', client_file_ref_id: null,
      archive_document_id: null, vorgang_id: 'v-a', expense_id: null, payload: JSON.parse(JSON.stringify(payload)),
      updated_at: '2026-09-30T10:00:00.000Z', deleted: false, row_version: 1,
    };
    const pulled = mergeInboxItemsFromPull([], [row], { deviceId: 'dev-b', workspaceId: 'ws-1', dirty: new Set() });
    expect(pulled.items[0]!.vorgangAssignment).toEqual(assignment);
    expect(pulled.items[0]!.vorgangId).toBe('v-a');
  });
});
