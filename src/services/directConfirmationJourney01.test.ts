/**
 * OFFICEPILOT-DIRECT-CONFIRMATION-OWN-COMPANY-RESOLUTION-01E — die Mittelstrecke.
 *
 * Die bisherigen Tests prüften die Entscheidungstabelle mit handgebauten
 * Signalen und die UI getrennt davon; die Strecke dazwischen — echtes Dokument
 * annehmen, echten Vorgang aus dem Store lesen, echten Adapter befragen — lief
 * nie. Genau dort versagte der Produktpfad.
 *
 * Dieser Test geht deshalb den vollständigen Weg und rendert am Ende das
 * tatsächliche Panel.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createElement } from 'react';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './contractIntelligenceService';
import { acceptContractOrderFromProposal } from './contractOrderAcceptService';
import { resolveOrderConfirmationPathForVorgang } from './orderConfirmationPathService';
import { VorgangContractConfirmPanel } from '../components/vorgang/VorgangContractConfirmPanel';
import { t, type TranslationKey } from '../i18n';
import type { InboxItem } from '../types/models';

vi.mock('./persistenceService', async () => {
  const actual = await vi.importActual<typeof import('./persistenceService')>(
    './persistenceService',
  );
  return { ...actual, persistAll: vi.fn() };
});

const OWN_PROFILE = {
  companyName: 'Cirmak Haustechnik GmbH',
  street: 'Bahnhofstraße 15',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
};

const PAGE_1 = [
  'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
  'Auftraggeber Westfalen Projektbau GmbH',
  'Industriestraße 27',
  '33689 Bielefeld',
  'Ansprechpartner: Daniel Krüger',
  'Auftragnehmer Cirmak Haustechnik GmbH',
  'Bahnhofstraße 15',
  '32105 Bad Salzuflen',
  'Geschäftsführer: Saban Irmak',
  'Bauvorhaben Logistikzentrum - Dachsanierung',
  'Vertragsdatum 09.08.2026',
].join('\n');

const PAGE_2 = [
  'Anlage 2 - Leistungsverzeichnis',
  'Pos. Menge Einh. Bezeichnung EP netto Gesamt netto',
  '01 950 m² PE-Dampfsperre luftdicht herstellen 3,80 3.610,00',
  '02 118 lfm Attikaanschlüsse herstellen 24,00 2.832,00',
].join('\n');

/** Vertauschte Richtung: die eigene Firma beauftragt selbst. */
const REVERSED_PAGE_1 = [
  'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
  'Auftraggeber Cirmak Haustechnik GmbH',
  'Bahnhofstraße 15',
  '32105 Bad Salzuflen',
  'Geschäftsführer: Saban Irmak',
  'Auftragnehmer Fremd Dach GmbH',
  'Fremdweg 9',
  '44444 Fremdstadt',
  'Geschäftsführer: Frank Fremd',
  'Vertragsdatum 09.08.2026',
].join('\n');

function acceptJourney(page1: string, customer: string, id: string) {
  const pages = [
    { pageNumber: 1, text: page1 },
    { pageNumber: 2, text: PAGE_2 },
  ];
  const text = pages.map((page) => page.text).join('\n\n');
  const intelligence = analyzeContractIntelligenceFromText(text, pages);
  const item: InboxItem = {
    ...createAuftragInboxItem(),
    id,
    sender: customer,
    recognizedData: {
      Kunde: customer,
      _vertragstext: text,
      _pageTexts: JSON.stringify(pages),
    },
  };
  const proposal = buildContractOrderProposal(item, intelligence ?? undefined);
  hydrateInboxStore([item]);
  hydrateVorgangStore([]);

  const result = acceptContractOrderFromProposal({
    item,
    proposal: proposal!,
    selectedPositions: proposal!.positions,
    companyName: OWN_PROFILE.companyName,
    // Confirm-first: der Nutzer hat den Kunden im Eingang bereits entschieden.
    customerDecision: { kind: 'new', input: { name: customer } },
  });
  return result;
}

function renderPanel(vorgangId: string): string {
  const vorgang = getVorgangById(vorgangId)!;
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(VorgangContractConfirmPanel, {
        vorgang,
        translate: (key: TranslationKey) => t(key, 'de'),
        onUpdated: () => {},
        onToast: () => {},
      }),
    );
  });
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
}

describe('OFFICEPILOT-DIRECT-CONFIRMATION-JOURNEY-01E', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  it('A: Annahme → Vorgang → echter Adapter liefert den direkten Prüfweg', () => {
    const result = acceptJourney(PAGE_1, 'Westfalen Projektbau GmbH', 'inbox-journey-a');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const vorgang = getVorgangById(result.vorgang.id)!;
    expect(vorgang.status).toBe('eingegangen');
    expect(vorgang.contractConfirmation).toBeUndefined();

    const resolved = resolveOrderConfirmationPathForVorgang(vorgang);
    expect(resolved.signals.ownCompanyRole).toBe('auftragnehmer');
    expect(resolved.path).toBe('direct_confirmation_review');
  });

  it('B: das Panel zeigt den Prüfbereich ohne vorherige Verhandlung', () => {
    const result = acceptJourney(PAGE_1, 'Westfalen Projektbau GmbH', 'inbox-journey-b');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const html = renderPanel(result.vorgang.id);

    expect(html).toContain('confirmation-review-card');
    expect(html).toContain('Auftrag prüfen und bestätigen');
    expect(getVorgangById(result.vorgang.id)?.status).toBe('eingegangen');
  });

  it('C: bei umgekehrter Richtung bleibt der Prüfbereich aus', () => {
    const result = acceptJourney(REVERSED_PAGE_1, 'Fremd Dach GmbH', 'inbox-journey-c');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const vorgang = getVorgangById(result.vorgang.id)!;
    expect(resolveOrderConfirmationPathForVorgang(vorgang).path).not.toBe(
      'direct_confirmation_review',
    );
    expect(renderPanel(result.vorgang.id)).not.toContain('confirmation-review-card');
  });
});
