/**
 * PRODUCT-ACCEPTANCE-FIX-01C (F-02/F-03) — Assistent zeigt verständliches
 * Deutsch: keine rohen Schlüssel, ein Tankbeleg ist keine Materialrechnung,
 * gleiche Hinweise erscheinen nur einmal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { resetCompanySessionForTests } from './services/brain/companySessionService';
import {
  analyzeInboxWorkflow,
  isMaterialInvoiceInbox,
} from './services/brain/workflowIntelligenceService';
import { translateWorkflowMessage, tryResolveWorkflowQuestion } from './services/brain/workflowKnowledgeResolver';
import { buildProactiveHints } from './services/brain/companyProactiveHintsService';
import { createMaterialInboxItem, createAuftragInboxItem } from './test/fixtures';
import type { CompanySessionContext } from './types/companySession';
import type { InboxItem } from './types/models';

const testProfile = {
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

function tankbeleg(): InboxItem {
  return {
    ...createAuftragInboxItem({ id: 'inbox-tank-01c' }),
    title: 'Tankbeleg – Aral Station Nord',
    sender: 'Aral Station Nord',
    classifiedKind: 'tankbeleg',
    documentType: 'eingangsrechnung',
    recognizedData: { Betrag: '92,95 EUR', Datum: '10.02.2026' },
  } as InboxItem;
}

function session(inboxId: string): CompanySessionContext {
  return { updatedAt: new Date().toISOString(), currentInboxId: inboxId, lastUploadInboxId: inboxId };
}

beforeEach(() => {
  resetCompanySessionForTests();
  hydrateCompanyProfileStore(testProfile);
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
});

describe('F-02 — keine rohen Schlüssel im Assistenten', () => {
  it('bekannte Risiko-/Empfehlungsschlüssel werden übersetzt', () => {
    expect(translateWorkflowMessage('workflowIntelligence.risk.materialWithoutVorgang')).toBe(
      'Material ohne zugeordneten Auftrag.',
    );
    expect(translateWorkflowMessage('workflowIntelligence.recommend.assignMaterial')).toBe(
      'Diese Materialrechnung sollte einem Auftrag zugeordnet werden.',
    );
  });

  it('unbekannter Schlüssel zeigt einen lesbaren Hinweis, nie den Rohschlüssel', () => {
    const text = translateWorkflowMessage('workflowIntelligence.risk.doesNotExist');
    expect(text).not.toContain('workflowIntelligence');
    expect(text).not.toMatch(/^[a-z]+(\.[a-zA-Z]+){2,}$/);
    expect(text.length).toBeGreaterThan(5);
  });

  it('Materialrechnung ohne Auftrag: Antwortzeilen enthalten Text statt Schlüssel', () => {
    const material = createMaterialInboxItem();
    hydrateInboxStore([material]);
    const result = tryResolveWorkflowQuestion('Was soll ich heute erledigen?', session(material.id));
    expect(result).not.toBeNull();
    const bullets = result!.assistantAnswer.bullets;
    expect(bullets.some((b) => b.includes('Material ohne zugeordneten Auftrag'))).toBe(true);
    expect(bullets.join(' ')).not.toContain('workflowIntelligence.');
  });
});

describe('F-03 — Tankbeleg ist keine Materialrechnung', () => {
  it('isMaterialInvoiceInbox: erkannte Art entscheidet, Dokumenttyp nur ohne Art', () => {
    expect(isMaterialInvoiceInbox(tankbeleg())).toBe(false);
    expect(isMaterialInvoiceInbox(createMaterialInboxItem())).toBe(true);
    expect(
      isMaterialInvoiceInbox({ ...createMaterialInboxItem(), classifiedKind: 'eingangsrechnung' } as InboxItem),
    ).toBe(true);
    expect(
      isMaterialInvoiceInbox({ ...createMaterialInboxItem(), classifiedKind: 'hotelrechnung' } as InboxItem),
    ).toBe(false);
  });

  it('Tankbeleg ohne Auftrag: keine Ablauf-Einschätzung mit Werkvertrag/Auftrag-Markierungen', () => {
    const item = tankbeleg();
    hydrateInboxStore([item]);
    expect(analyzeInboxWorkflow(item.id)).toBeNull();
    const result = tryResolveWorkflowQuestion('Was soll ich heute erledigen?', session(item.id));
    const text = result ? result.assistantAnswer.bullets.join(' ') + result.assistantAnswer.summary : '';
    expect(text).not.toContain('Materialrechnung');
    expect(text).not.toContain('Werkvertrag');
    expect(text).not.toContain('workflowIntelligence.');
  });

  it('Tankbeleg: keine Material-Hinweise aus Ablauf oder Finanzen', () => {
    const item = tankbeleg();
    hydrateInboxStore([item]);
    const hints = buildProactiveHints(session(item.id));
    expect(hints.some((h) => /material/i.test(h.messageKey))).toBe(false);
  });

  it('Hinweise aus den Daten erscheinen nur einmal', () => {
    const material = createMaterialInboxItem();
    hydrateInboxStore([material]);
    const hints = buildProactiveHints(session(material.id));
    const signatures = hints.map((h) => `${h.messageKey}|${JSON.stringify(h.params ?? {})}`);
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(hints.some((h) => h.messageKey === 'workflowIntelligence.recommend.assignMaterial')).toBe(true);
  });
});
