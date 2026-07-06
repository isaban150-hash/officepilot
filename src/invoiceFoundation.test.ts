import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { BETA_TEST_SETUP, isBetaTestMode } from './config/betaTestMode';
import { createSeedState } from './services/persistenceService';
import {
  buildAbschlagDraft,
  buildInvoiceDraftForType,
  buildRechnungDraft,
  calculateInvoiceTotals,
} from './services/invoiceService';
import { buildLegalNotices, buildSkontoText } from './services/invoiceTaxService';
import { parseInvoiceDocumentType } from './services/invoiceTypeService';
import { buildInvoicePrintModel } from './services/invoicePrintModel';
import { createTestVorgang, testSetup } from './test/fixtures';
import {
  createKleinunternehmerPrintSetup,
  createNormalPrintSetup,
  createReverseChargePrintSetup,
} from './test/invoicePrintFixtures';
import { hydrateVorgangStore } from './services/vorgangService';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';

describe('INVOICE-FOUNDATION-01', () => {
  describe('Beta empty start', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('seedet im Beta-Modus keine Mock-Geschäftsdaten', () => {
      vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
      expect(isBetaTestMode()).toBe(true);

      const seed = createSeedState({ ...BETA_TEST_SETUP });
      expect(seed.inboxItems).toEqual([]);
      expect(seed.vorgaenge).toEqual([]);
      expect(seed.tasks).toEqual([]);
      expect(seed.documents).toEqual([]);
      expect(seed.expenses).toEqual([]);
      expect(seed.communicationHistory).toEqual([]);
      expect(seed.setup.setupComplete).toBe(true);
      expect(seed.companyProfile?.companyName).toBe('Musterbetrieb GmbH');
    });
  });

  describe('Rechnungstyp Standard', () => {
    beforeEach(() => {
      hydrateVorgangStore([createTestVorgang()]);
    });

    it('Standard ist normale Rechnung', () => {
      expect(parseInvoiceDocumentType(null)).toBe('rechnung');
      const draft = buildRechnungDraft('v-test-1', testSetup);
      expect(draft?.type).toBe('rechnung');
    });

    it('Abschlagsrechnung nur bei expliziter Auswahl', () => {
      const draft = buildAbschlagDraft('v-test-1', testSetup);
      expect(draft?.type).toBe('abschlag');
      expect(draft?.abschlagNumber).toBe(1);
    });

    it('Teilrechnung und Gutschrift sind wählbar', () => {
      expect(buildInvoiceDraftForType('v-test-1', testSetup, 'teilrechnung')?.type).toBe(
        'teilrechnung',
      );
      expect(buildInvoiceDraftForType('v-test-1', testSetup, 'gutschrift')?.type).toBe('gutschrift');
    });
  });

  describe('Steuerlogik', () => {
    it('Standardrechnung zeigt MwSt.', () => {
      const { draft, setup } = createNormalPrintSetup();
      const totals = calculateInvoiceTotals(draft, setup);
      expect(totals.taxRate).toBe(19);
      expect(totals.tax).toBeGreaterThan(0);
    });

    it('Kleinunternehmer ohne MwSt. mit §19-Hinweis', () => {
      const { draft, setup } = createKleinunternehmerPrintSetup();
      const totals = calculateInvoiceTotals(draft, setup);
      expect(totals.taxRate).toBe(0);
      expect(buildLegalNotices('kleinunternehmer_19')[0]).toContain('§ 19 UStG');
      expect(buildLegalNotices('kleinunternehmer_19')[0]).toContain('berechnet');
      const model = buildInvoicePrintModel(draft, setup);
      expect(model.taxNotices[0]).toContain('berechnet');
      expect(model.summary.taxRate).toBe(0);
    });

    it('§13b ohne MwSt. mit Reverse-Charge-Hinweis', () => {
      const { draft, setup } = createReverseChargePrintSetup();
      const totals = calculateInvoiceTotals(draft, setup);
      expect(totals.taxRate).toBe(0);
      expect(buildLegalNotices('reverse_charge_13b')[0]).toContain('§ 13b UStG');
    });
  });

  describe('Skonto', () => {
    it('Skonto-Text nur wenn aktiviert', () => {
      const disabled = buildSkontoText({ ...DEFAULT_COMPANY_PROFILE, skontoEnabled: false });
      expect(disabled).toBe('');

      const enabled = buildSkontoText({
        ...DEFAULT_COMPANY_PROFILE,
        skontoEnabled: true,
        skontoPercent: 2,
        skontoDays: 10,
      });
      expect(enabled).toContain('2 % Skonto');
      expect(enabled).toContain('10 Tagen');
    });
  });

  describe('Branding & Layout', () => {
    it('Logo erscheint im Rechnungslayout', () => {
      const { draft, setup } = createNormalPrintSetup();
      draft.companySnapshot = {
        ...draft.companySnapshot,
        logoDataUrl: 'data:image/png;base64,TESTLOGO',
      };
      const model = buildInvoicePrintModel(draft, setup);
      expect(model.company.logoDataUrl).toBe('data:image/png;base64,TESTLOGO');
      expect(model.documentTitle).toBe('Rechnung');
    });

    it('Fußzeile enthält Firmendaten', () => {
      const { draft, setup } = createNormalPrintSetup();
      draft.companySnapshot = {
        ...draft.companySnapshot,
        managingDirector: 'Max Mustermann',
        invoiceFooterNotes: 'Vielen Dank für Ihr Vertrauen.',
      };
      const model = buildInvoicePrintModel(draft, setup);
      expect(model.footerNotes).toContain('Vielen Dank');
      expect(model.company.managingDirector).toBe('Max Mustermann');
    });
  });
});
