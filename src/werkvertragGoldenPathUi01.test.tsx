import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { t, type TranslationKey } from './i18n';
import type { ContractIntelligenceResult, ContractOrderProposal } from './types/documentIntelligence';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function buildProposal(): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [8],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {
      auftraggeber: {
        value: 'Muster Bau GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      auftragnehmer: {
        value: 'Cirmak Haustechnik GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      bauvorhaben: {
        value: 'BV Rüthen',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    parties: [
      {
        role: 'auftraggeber',
        name: 'Muster Bau GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      {
        role: 'auftragnehmer',
        name: 'Cirmak Haustechnik GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
    ],
    contractTotalNet: {
      value: 36029.05,
      status: 'confirmed',
      confidence: 'high',
      sourceText: 'Gesamtsumme netto 36.029,05 €',
    },
    positions: [
      {
        positionNumber: '1',
        description: 'PVC-Folie',
        unit: 'm²',
        quantity: 120,
        unitPrice: 240,
        lineTotal: 28800,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
    ],
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Muster Bau GmbH',
    contractor: 'Cirmak Haustechnik GmbH',
    constructionSite: 'BV Rüthen',
    contractDate: '02.03.2026',
    positionCount: intelligence.positions.length,
    contractTotalNet: '36.029,05 €',
    paymentTermsSummary: '14 Tage netto',
    reviewHints: [],
    positions: intelligence.positions,
    intelligence,
  };
}

describe('WERKVERTRAG-GOLDEN-PATH-UI-01', () => {
  // Wie in contractPartyRoles01: das Profil bleibt nicht für andere Tests stehen.
  afterEach(() => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE });
  });

  it('macht die ContractWorkspaceSummary zur primären sichtbaren Vertragsansicht', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal,
        translate,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary"');
    expect(html).toContain('data-testid="auftragskarte-contract"');
    expect(html.indexOf('data-testid="contract-workspace-summary"')).toBeLessThan(
      html.indexOf('data-testid="auftragskarte-contract"'),
    );
  });

  /*
   * WERKVERTRAG-GOLDEN-PATH-PROFILE-01B — „Ihr Betrieb" kommt aus dem
   * Firmenprofil, nicht aus `proposal.contractor`.
   *
   * Die Fixture setzte bisher kein Firmenprofil. Seit `e957b99`
   * (SCAN-CONTRACT-PARTY-ROLE-01B) vergleicht `isOwnCompanyParty` gegen das
   * tatsächliche Profil statt gegen den Auftragnehmer-Slot, aus dem der Wert
   * ohnehin stammt — der alte tautologische Vergleich markierte einen
   * **Kunden** als eigenen Betrieb. Ohne Profil kann OfficePilot zu Recht
   * nicht wissen, welche Partei der eigene Betrieb ist, und lässt das
   * Abzeichen weg.
   *
   * Das Profil wird deshalb gesetzt, und zwar rollenrichtig: Beim Werkvertrag
   * ist der eigene Betrieb der **Auftragnehmer**.
   */
  it('zeigt own-company als Auftragnehmer mit „Ihr Betrieb“', () => {
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Cirmak Haustechnik GmbH',
    });
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, translate }),
    );

    expect(html).toContain('Cirmak Haustechnik GmbH');
    expect(html).toContain('Ihr Betrieb');
    expect(html).toContain('Auftragnehmer');
    expect(html).not.toContain('data-testid="contract-workspace-summary-party-kunde');

    /*
     * Das Abzeichen steht genau einmal, und zwar am Auftragnehmer. Geprüft
     * wird es an der Zeile selbst: Stünde es an der Gegenpartei, wäre das der
     * Fehler aus der Zeit vor `e957b99`.
     */
    expect(html).toContain(
      'data-testid="contract-workspace-summary-party-auftraggeber-Muster Bau GmbH"',
    );
    expect(html).toContain(
      'data-testid="contract-workspace-summary-party-auftragnehmer-Cirmak Haustechnik GmbH"',
    );
    expect(html.match(/Ihr Betrieb/g) ?? [], 'Das Abzeichen steht mehrfach').toHaveLength(1);

    const auftraggeberStart = html.indexOf('party-auftraggeber-Muster Bau GmbH');
    const auftragnehmerStart = html.indexOf('party-auftragnehmer-Cirmak Haustechnik GmbH');
    const badge = html.indexOf('Ihr Betrieb');
    expect(auftraggeberStart).toBeGreaterThanOrEqual(0);
    expect(auftragnehmerStart).toBeGreaterThan(auftraggeberStart);
    expect(badge, 'Die Gegenpartei ist als eigener Betrieb markiert').toBeGreaterThan(
      auftragnehmerStart,
    );
  });

  it('zeigt Bauvorhaben, Vertragssumme und LV-Status aus bestehenden Contract-Daten', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, translate }),
    );

    expect(html).toContain('BV Rüthen');
    expect(html).toContain('36.029,05 €');
    expect(html).toContain('data-testid="contract-workspace-summary-lv"');
  });
});
