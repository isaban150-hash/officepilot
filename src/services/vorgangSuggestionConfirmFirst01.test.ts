/**
 * VORGANG-SUGGESTION-CONFIRM-FIRST-01 — Vorschlag ist keine Bestätigung.
 *
 * Ein errechneter exact-Vorschlag ohne gespeicherte Verknüpfung darf nicht als
 * bestehender Zustand auftreten. Bestätigt ist eine Verknüpfung ausschliesslich, wenn
 * isInboxLinkedToVorgang wahr ist — eine Legacy-vorgangId ohne linked/created reicht
 * nicht. Vorgangsdaten bleiben als proposed-Kontext erhalten und dienen nur dann als
 * Empfänger- oder Baustellen-Fallback, wenn das Dokument selbst nichts Sicheres liefert.
 *
 * Alle Fälle laufen über normale Store-Hydrierung und öffentliche Produktionsfunktionen.
 * Es wird kein Match-, suggestedVorgang-, BusinessInterpretation-, Summary-, Konflikt-
 * oder Ergebniswert von Hand gesetzt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { setTaskStoreForTests } from './taskStore';
import {
  hydrateVorgangStore,
  isInboxLinkedToVorgang,
  linkInboxToExistingVorgang,
} from './vorgangService';
import { processUploadedDocument } from './intakeWorkflowService';
import { buildDocumentCaseMatch } from './documentCaseMatchService';
import { buildDocumentSummary } from './documentSummary';
import { getDocumentWorkResultForItem } from './documentWorkResultService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { t, type TranslationKey } from '../i18n';
import type { InboxItem } from '../types/models';

const translate = (key: TranslationKey): string => t(key, 'de');

const OWN_COMPANY = 'Mustermann Sanitär GmbH';
const VORGANG_ID = 'v-suggest-confirm';
const VORGANG_TITLE = 'Neubau Kirchheide Halle 3';
const VORGANG_SITE = 'Industriering 8, 32657 Lemgo';
const VORGANG_CUSTOMER = 'Nordwerk Immobilien GmbH';
const DOCUMENT_CUSTOMER = 'Bauherrengemeinschaft Kirchheide GbR';
const DOCUMENT_SITE = 'Ostweg 4, 32756 Detmold';

/** Bauvorhaben + Baustelle treffen den Vorgang → same_project + same_site → exact. */
function seedStores(): void {
  localStorage.clear();
  setTaskStoreForTests([]);
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore({ companyName: OWN_COMPANY } as never);
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      title: VORGANG_TITLE,
      customer: VORGANG_CUSTOMER,
      baustelle: VORGANG_SITE,
    } as never),
  ]);
}

function offerItem(
  id: string,
  options: { customer?: string; site?: string } & Partial<InboxItem> = {},
): InboxItem {
  const { customer, site, ...rest } = options;
  return {
    ...createAuftragInboxItem(),
    id,
    title: `Angebot ${VORGANG_TITLE}`,
    classifiedKind: 'angebot',
    documentType: 'angebot',
    sender: OWN_COMPANY,
    vorgangId: undefined,
    vorgangTitle: undefined,
    vorgangLinkStatus: undefined,
    recognizedData: {
      Dokumentart: 'angebot',
      Absender: OWN_COMPANY,
      Lieferant: OWN_COMPANY,
      Bauvorhaben: VORGANG_TITLE,
      Baustelle: site ?? VORGANG_SITE,
      Datum: '01.04.2026',
      ...(customer ? { Kunde: customer, Auftraggeber: customer } : {}),
    },
    ...rest,
  } as unknown as InboxItem;
}

function analyse(item: InboxItem) {
  const workflow = processUploadedDocument(item.id)!;
  const summary = buildDocumentSummary(item, workflow, { translate });
  const bi = workflow.businessInterpretation;
  return {
    workflow,
    summary,
    bi,
    counterparty: bi?.facts.parties.counterparty,
    site: bi?.facts.subject.site,
    fact: (id: string) => summary.facts.find((entry) => entry.id === id)?.value,
  };
}

describe('VORGANG-SUGGESTION-CONFIRM-FIRST-01', () => {
  beforeEach(() => seedStores());

  it('A: errechneter Vorschlag ohne Verknuepfung gilt nicht als bestaetigter Zustand', () => {
    const item = offerItem('vscf-a', { customer: DOCUMENT_CUSTOMER });
    hydrateInboxStore([item]);

    expect(buildDocumentCaseMatch(item).matchStatus).toBe('exact');
    expect(item.vorgangId).toBeUndefined();
    expect(item.vorgangLinkStatus).toBeUndefined();
    expect(isInboxLinkedToVorgang(item)).toBe(false);

    const { workflow, summary, bi, counterparty, fact } = analyse(item);

    expect(workflow.suggestedVorgang?.vorgangId).toBe(VORGANG_ID);
    expect(bi?.vorgangRef.status).toBe('suggested');
    expect(counterparty?.certainty).not.toBe('confirmed_by_existing_state');
    expect(counterparty?.certainty).toBe('proposed');

    // Der auf dem Dokument erkannte Empfänger bleibt sichtbar.
    expect(fact('customer')).toBe(DOCUMENT_CUSTOMER);
    expect(fact('customer')).not.toBe(VORGANG_CUSTOMER);

    expect(summary.primaryAction.id).toBe('link_vorgang');
    expect(workflow.nextActions.some((a) => a.id === 'link_vorgang' && a.enabled)).toBe(true);
    // Keine automatische Verknüpfung durch die Analyse.
    expect(getInboxItemById('vscf-a')?.vorgangId).toBeUndefined();
    expect(getInboxItemById('vscf-a')?.vorgangLinkStatus).toBeUndefined();

    // Ein blosser Vorschlag darf keinen Konflikt erzeugen, der einen bestaetigten
    // Vorgangszustand voraussetzt.
    const conflictIds = (bi?.conflicts ?? []).map((conflict) => conflict.id);
    expect(conflictIds).not.toContain('party_vorgang_customer_mismatch');
    expect(conflictIds).not.toContain('site_vorgang_mismatch');

    // Das Analyseergebnis darf gespeichert werden — aber ohne falsche Bestätigung.
    const stored = getDocumentWorkResultForItem('vscf-a');
    expect(stored).toBeTruthy();
    expect(stored?.businessInterpretation?.facts.parties.counterparty?.certainty).toBe('proposed');
  });

  it('B: bestaetigte Verknuepfung ist ein bestehender Zustand, schreibt den Empfaenger aber nicht um', () => {
    const item = offerItem('vscf-b', { customer: DOCUMENT_CUSTOMER });
    hydrateInboxStore([item]);
    expect(linkInboxToExistingVorgang(item, VORGANG_ID)).toBeTruthy();

    const stored = getInboxItemById('vscf-b')!;
    expect(isInboxLinkedToVorgang(stored)).toBe(true);
    expect(stored.vorgangLinkStatus).toBe('linked');

    const { bi, summary, counterparty, fact } = analyse(stored);

    expect(bi?.vorgangRef.status).toBe('linked');
    expect(counterparty?.certainty).toBe('confirmed_by_existing_state');

    // Der bestätigte Vorgang bestätigt die Zuordnung, nicht den Empfänger.
    expect(fact('customer')).toBe(DOCUMENT_CUSTOMER);
    expect(fact('customer')).not.toBe(VORGANG_CUSTOMER);
    expect(summary.primaryAction.id).toBe('open_vorgang');
  });

  it('C: Legacy-vorgangId ohne linked oder created ist keine Bestaetigung', () => {
    const item = offerItem('vscf-c', {
      customer: DOCUMENT_CUSTOMER,
      vorgangId: VORGANG_ID,
      vorgangTitle: VORGANG_TITLE,
    });
    hydrateInboxStore([item]);

    expect(item.vorgangId).toBe(VORGANG_ID);
    expect(item.vorgangLinkStatus).toBeUndefined();
    expect(isInboxLinkedToVorgang(item)).toBe(false);

    const { workflow, bi, counterparty, fact } = analyse(item);

    expect(bi?.vorgangRef.status).not.toBe('linked');
    expect(counterparty?.certainty).not.toBe('confirmed_by_existing_state');
    expect(fact('customer')).toBe(DOCUMENT_CUSTOMER);
    expect(workflow.nextActions.some((a) => a.id === 'link_vorgang' && a.enabled)).toBe(true);
  });

  it('D: ohne Dokumentkunden bleibt der vorgeschlagene Vorgangskunde als proposed-Fallback sichtbar', () => {
    const item = offerItem('vscf-d');
    hydrateInboxStore([item]);

    const { bi, counterparty, fact } = analyse(item);

    expect(bi?.vorgangRef.status).toBe('suggested');
    expect(counterparty?.certainty).toBe('proposed');
    expect(fact('customer')).toBe(VORGANG_CUSTOMER);
    expect(getInboxItemById('vscf-d')?.vorgangId).toBeUndefined();
  });

  it('E: ohne Dokumentkunden bleibt der bestaetigte Vorgangskunde als Fallback sichtbar', () => {
    const item = offerItem('vscf-e');
    hydrateInboxStore([item]);
    expect(linkInboxToExistingVorgang(item, VORGANG_ID)).toBeTruthy();

    const stored = getInboxItemById('vscf-e')!;
    const { bi, counterparty, fact } = analyse(stored);

    expect(bi?.vorgangRef.status).toBe('linked');
    expect(counterparty?.certainty).toBe('confirmed_by_existing_state');
    expect(fact('customer')).toBe(VORGANG_CUSTOMER);
  });

  it('Baustelle: dokumenteigene Baustelle gewinnt, fehlt sie greift der Vorgangskontext als proposed', () => {
    const own = offerItem('vscf-site-own', {
      customer: DOCUMENT_CUSTOMER,
      site: DOCUMENT_SITE,
    });
    hydrateInboxStore([own]);
    const ownResult = analyse(own);
    expect(ownResult.site?.value).toBe(DOCUMENT_SITE);
    expect(ownResult.site?.certainty).toBe('detected');

    // Ohne Baustelle traegt same_site den exact-Match nicht mehr. Der Treffer entsteht
    // hier stattdessen ueber same_project + same_customer — der Dokumentkunde ist also
    // bewusst der Vorgangskunde. Weder Vorgangs-ID noch suggestedVorgang werden gesetzt.
    seedStores();
    const withoutSite = offerItem('vscf-site-none', { customer: VORGANG_CUSTOMER });
    delete (withoutSite.recognizedData as Record<string, string>).Baustelle;
    hydrateInboxStore([withoutSite]);

    const match = buildDocumentCaseMatch(withoutSite);
    expect(match.matchStatus).toBe('exact');
    expect(match.reasons).toEqual(expect.arrayContaining(['same_project', 'same_customer']));
    expect(match.reasons).not.toContain('same_site');
    expect(isInboxLinkedToVorgang(withoutSite)).toBe(false);

    const fallback = analyse(withoutSite);
    expect(fallback.workflow.suggestedVorgang?.vorgangId).toBe(VORGANG_ID);
    expect(fallback.site?.value).toBe(VORGANG_SITE);
    expect(fallback.site?.certainty).toBe('proposed');
    expect(fallback.site?.source).toBe('vorgangState');
    expect(getInboxItemById('vscf-site-none')?.vorgangId).toBeUndefined();
    expect(getInboxItemById('vscf-site-none')?.vorgangLinkStatus).toBeUndefined();
  });
});
