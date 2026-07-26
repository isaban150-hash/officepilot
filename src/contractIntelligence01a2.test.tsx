import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { t, type TranslationKey } from './i18n';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './services/contractIntelligenceService';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { createAuftragInboxItem } from './test/fixtures';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from './test/werkvertragMultiSectionFixtures';

const translate = (key: TranslationKey) => t(key, 'de');

const CONTROL_B_WARTUNG = `
Wartungsvertrag
Auftraggeber: Nord Technik AG
Dienstleister: Klima Service GmbH
Vertragsdatum: 10.01.2026
Vertragsgegenstand: Wartung der Klimaanlagen
Laufzeit: 24 Monate
Pauschale: 450,00 € monatlich
Reaktionszeit: 24 Stunden
Kündigungsfrist: 3 Monate zum Laufzeitende
Automatische Verlängerung: um 12 Monate
Zahlungsbedingungen: monatlich im Voraus
`.trim();

const CONTROL_C_MIETE = `
Mietvertrag
Vermieter: Haus & Hof GmbH
Mieter: Büro Partner UG
Vertragsdatum: 01.02.2026
Mietobjekt: Bürofläche Am Markt 3, 44135 Dortmund
Mietbeginn: 01.03.2026
Laufzeit: 36 Monate
Kaltmiete: 1.850,00 €
Nebenkosten: 320,00 €
Kaution: 5.550,00 €
Kündigungsfrist: 6 Monate zum Monatsende
`.trim();

const CONTROL_D_UNCLEAR = `
Vertrag
Zwischen Alpha Soft GmbH und Beta Consulting.
Datum: 15.04.2026
Angebotsnummer: ANG-7781
Leistung: Unterstützung bei der Projektkoordination
Betrag: 2.500,00 €
`.trim();

function inboxFor(text: string, id: string) {
  return {
    ...createAuftragInboxItem(),
    id,
    title: 'Contract control case',
    recognizedData: {
      _vertragstext: text,
      _extractedText: text,
      Betreff: 'Vertrag',
    },
  };
}

describe('CONTRACT-INTELLIGENCE-01A2 — allgemeine Vertragsintelligenz', () => {
  describe('Kontrollfall A — Bau-/Werkvertrag mit LV', () => {
    it('erkennt Parteien, Bauvorhaben, Summe und LV-Positionen strukturiert', () => {
      const text = buildSyntheticWerkvertragText();
      const pages = buildSyntheticWerkvertragPages();
      const result = analyzeContractIntelligenceFromText(text, pages);
      expect(result).not.toBeNull();

      expect(result!.contractType?.family).toBe('werkvertrag');
      const ag = result!.parties?.find((party) => party.role === 'auftraggeber');
      const sub = result!.parties?.find((party) => party.role === 'subunternehmer');
      expect(ag?.name).toContain('Isobautec GmbH');
      expect(sub?.name).toContain('Ivan Iliev');
      expect(result!.contractFields.auftraggeber?.value).toContain('Isobautec GmbH');
      expect(result!.contractFields.auftragnehmer?.value).toContain('Ivan Iliev');
      expect(result!.contractFields.auftraggeber?.value).not.toContain('Ivan Iliev');
      expect(result!.contractFields.bauvorhaben?.value).toMatch(/Sägewerk|Fisch|Abdichtung/i);
      expect(result!.contractFields.baustelle?.value).toContain('Möhnetal 55');
      expect(result!.contractTotalNet?.value).toBeCloseTo(36029.05, 2);
      expect(result!.contractFields.zahlungsbedingungen?.value).toMatch(/Skonto|netto/i);
      expect(result!.contractFields.gewaehrleistung?.value).toMatch(/5 Jahre/i);
      expect(result!.contractFields.stundenlohn?.value).toMatch(/55/);
      expect(result!.contractFields.wartezeitregelung?.value).toMatch(/Wartezeit|80/i);
      expect(result!.contractFields.bgBau?.value).toMatch(/BG\s*BAU/i);
      expect(result!.contractFields.sokaBau?.value).toMatch(/SOKA/i);

      const pvc = result!.positions.find((position) => /PVC-Folie/i.test(position.description));
      expect(pvc).toBeTruthy();
      expect(pvc!.quantity).toBeCloseTo(4799, 0);
      expect(pvc!.unitPrice).toBeCloseTo(2.8, 2);
      expect(pvc!.lineTotal).toBeCloseTo(13437.2, 2);

      const kuppel = result!.positions.find((position) => /Lichtkuppel/i.test(position.description));
      expect(kuppel).toBeTruthy();
      expect(kuppel!.quantity).toBeCloseTo(4, 0);
      expect(kuppel!.unit).toMatch(/Stück|St\.?/i);
      expect(kuppel!.unitPrice).toBeCloseTo(60, 2);
      expect(kuppel!.lineTotal).toBeCloseTo(240, 2);
    });

    it('stellt UI-Reihenfolge dar und hält Originaltext einklappbar, OCR nicht primär', () => {
      const text = buildSyntheticWerkvertragText();
      const pages = buildSyntheticWerkvertragPages();
      const item = inboxFor(text, 'inbox-ci01a2-a');
      item.recognizedData._pageTexts = JSON.stringify(pages);
      const intelligence = analyzeContractIntelligenceFromText(text, pages);
      const proposal = buildContractOrderProposal(item, intelligence);
      expect(proposal).not.toBeNull();

      const summaryHtml = renderToStaticMarkup(
        createElement(ContractWorkspaceSummary, {
          proposal: proposal!,
          translate,
          item,
        }),
      );
      expect(summaryHtml).toContain('Vertragsübersicht');
      expect(summaryHtml).toContain('Vertragsparteien');
      expect(summaryHtml).toContain('Isobautec GmbH');
      expect(summaryHtml).toContain('Ivan Iliev');
      expect(summaryHtml.indexOf('Vertragsübersicht')).toBeLessThan(
        summaryHtml.indexOf('Vertragsparteien'),
      );

      const panelHtml = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onDiscard: vi.fn(),
        }),
      );
      expect(panelHtml).toContain('data-testid="contract-order-proposal-original-text"');
      expect(panelHtml).toContain('<details');
      expect(panelHtml).toContain('Originaltext');
      // Primary surface is structured summary, not a raw OCR wall.
      expect(panelHtml).toContain('data-testid="contract-workspace-summary"');
      const overviewCount = (panelHtml.match(/Vertragsübersicht/g) ?? []).length;
      expect(overviewCount).toBe(1);
    });
  });

  describe('Kontrollfall B — Wartungsvertrag ohne LV', () => {
    it('erkennt Laufzeit, Pauschale und Kündigung ohne Werkvertragsfelder', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_B_WARTUNG);
      expect(result).not.toBeNull();
      expect(result!.contractType?.family).toBe('wartungsvertrag');
      expect(result!.positions.length).toBe(0);
      expect(result!.commonFields?.laufzeit?.value).toMatch(/24/i);
      expect(result!.commonFields?.kuendigungsfrist?.value).toMatch(/3 Monate/i);
      expect(result!.typeSpecificFields?.pauschale?.value).toMatch(/450/);
      expect(result!.typeSpecificFields?.reaktionszeit?.value).toMatch(/24/);
      expect(result!.contractFields.bauvorhaben?.status ?? 'not_found').toBe('not_found');
      expect(result!.contractFields.baustelle?.status ?? 'not_found').toBe('not_found');
      expect(result!.contractFields.bgBau?.status ?? 'not_found').toBe('not_found');

      const item = inboxFor(CONTROL_B_WARTUNG, 'inbox-ci01a2-b');
      const proposal = buildContractOrderProposal(item, result);
      expect(proposal).not.toBeNull();
      const view = buildContractWorkspaceSummaryView(proposal!);
      expect(view.typeSpecificRows.some((row) => row.id === 'bauvorhaben')).toBe(false);
      expect(view.typeSpecificRows.some((row) => row.id === 'pauschale')).toBe(true);

      const panelHtml = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
        }),
      );
      expect(panelHtml).not.toContain('data-testid="contract-order-positions"');
      expect(panelHtml).not.toContain('Bauvorhaben');
    });
  });

  describe('Kontrollfall C — Mietvertrag', () => {
    it('erkennt Parteien, Objekt, Miete und Laufzeit ohne Werkvertragsfelder', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_C_MIETE);
      expect(result).not.toBeNull();
      expect(result!.contractType?.family).toBe('mietvertrag');
      expect(result!.parties?.some((party) => party.role === 'vermieter')).toBe(true);
      expect(result!.parties?.some((party) => party.role === 'mieter')).toBe(true);
      expect(result!.typeSpecificFields?.mietobjekt?.value).toMatch(/Dortmund/i);
      expect(result!.typeSpecificFields?.kaltmiete?.value).toMatch(/1\.850/);
      expect(result!.commonFields?.laufzeit?.value).toMatch(/36/);
      expect(result!.commonFields?.kuendigungsfrist?.value).toMatch(/6 Monate/i);
      expect(result!.contractFields.stundenlohn?.status ?? 'not_found').toBe('not_found');
      expect(result!.contractFields.baustelle?.status ?? 'not_found').toBe('not_found');
      expect(result!.positions.length).toBe(0);

      const view = buildContractWorkspaceSummaryView(
        buildContractOrderProposal(inboxFor(CONTROL_C_MIETE, 'inbox-ci01a2-c'), result)!,
      );
      expect(view.typeSpecificRows.some((row) => row.id === 'kaltmiete')).toBe(true);
      expect(view.typeSpecificRows.some((row) => row.id === 'baustelle')).toBe(false);
    });
  });

  describe('Kontrollfall D — unklare Vertragsart', () => {
    it('bleibt stabil und erfindet keine typabhängigen Werkvertragsfelder', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_D_UNCLEAR);
      expect(result).not.toBeNull();
      expect(['general_contract', 'unknown']).toContain(result!.contractType?.family);
      expect(result!.contractType?.status).toBe('review_required');
      expect(result!.contractFields.vertragsnummer?.status ?? 'not_found').toBe('not_found');
      expect(result!.contractFields.bauvorhaben?.status ?? 'not_found').toBe('not_found');
      expect(result!.contractFields.baustelle?.status ?? 'not_found').toBe('not_found');
      // Angebotsnummer must not become Vertragsnummer.
      expect(result!.contractFields.vertragsnummer?.value ?? '').not.toMatch(/ANG-7781/);
    });
  });

  describe('Commit-Blocker-Korrekturen', () => {
    it('Dienstleistung ohne Überschrift mit AG/AN/Abnahme wird nicht als Werkvertrag erkannt', () => {
      const text = `
Auftraggeber: Nord Service AG
Auftragnehmer: Technik Partner GmbH
Vertragsdatum: 12.02.2026
Die Abnahme der Leistung erfolgt nach Fertigstellung.
Vergütung: 1.200,00 € monatlich
`.trim();
      const result = analyzeContractIntelligenceFromText(text);
      expect(result).not.toBeNull();
      expect(result!.contractType?.family).not.toBe('werkvertrag');
      expect(result!.contractType?.family).not.toBe('subunternehmervertrag');
      expect(['general_contract', 'unknown', 'dienstleistungsvertrag']).toContain(
        result!.contractType?.family,
      );
      expect(result!.contractType?.status).toBe('review_required');
    });

    it('Mietvertrag erzeugt kein Leistungsverzeichnis', () => {
      const text = `
Mietvertrag
Vermieter: Haus & Hof GmbH
Mieter: Büro Partner UG
Mietobjekt: Büro Am Markt 3
Kaltmiete: 1.850,00 €
Laufzeit: 36 Monate
1 10,00 Stück Büromöbel EP 50,00 € GP 500,00 €
2 5,00 qm Teppich EP 20,00 € GP 100,00 €
`.trim();
      const result = analyzeContractIntelligenceFromText(text);
      expect(result).not.toBeNull();
      expect(result!.contractType?.family).toBe('mietvertrag');
      expect(result!.positions.length).toBe(0);
    });

    it('echter Werkvertrag behält PVC, Lichtkuppel und Vertragssumme 36.029,05 €', () => {
      const text = buildSyntheticWerkvertragText();
      const pages = buildSyntheticWerkvertragPages();
      const result = analyzeContractIntelligenceFromText(text, pages);
      expect(result).not.toBeNull();
      expect(result!.contractType?.family).toBe('werkvertrag');
      expect(result!.contractTotalNet?.value).toBeCloseTo(36029.05, 2);
      const pvc = result!.positions.find((position) => /PVC-Folie/i.test(position.description));
      expect(pvc?.quantity).toBeCloseTo(4799, 0);
      expect(pvc?.unitPrice).toBeCloseTo(2.8, 2);
      expect(pvc?.lineTotal).toBeCloseTo(13437.2, 2);
      const kuppel = result!.positions.find((position) => /Lichtkuppel/i.test(position.description));
      expect(kuppel?.quantity).toBeCloseTo(4, 0);
      expect(kuppel?.unitPrice).toBeCloseTo(60, 2);
      expect(kuppel?.lineTotal).toBeCloseTo(240, 2);
    });
  });

  describe('Regressionen', () => {
    it('Vertrag ohne clauses bleibt kompatibel', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_C_MIETE);
      const proposal = buildContractOrderProposal(
        inboxFor(CONTROL_C_MIETE, 'inbox-ci01a2-no-clauses'),
        result,
      );
      expect(proposal).not.toBeNull();
      const html = renderToStaticMarkup(
        createElement(ContractWorkspaceSummary, {
          proposal: proposal!,
          translate,
        }),
      );
      expect(html).toContain('Vertragsübersicht');
    });

    it('Zahlungszeile mit nach Abnahme erzeugt keine Abnahmeklausel', () => {
      const text = `
Werkvertrag
Auftraggeber: Beispiel AG
Auftragnehmer: Beispiel AN
Zahlungsbedingungen: Schlussrechnung nach Abnahme
Vertragsdatum: 01.01.2026
`.trim();
      const result = analyzeContractIntelligenceFromText(text);
      expect(result).not.toBeNull();
      const clauseIds = new Set((result!.clauses ?? []).map((clause) => clause.id));
      expect(clauseIds.has('abnahme')).toBe(false);
    });

    it('einzelne Stundenlohnzeile erzeugt keine Stundenlohnarbeiten-Klausel', () => {
      const text = `
Werkvertrag
Auftraggeber: Beispiel AG
Auftragnehmer: Beispiel AN
Stundenlohn: 48,00 €/Std.
Vertragsdatum: 01.01.2026
`.trim();
      const result = analyzeContractIntelligenceFromText(text);
      expect(result).not.toBeNull();
      expect(result!.contractFields.stundenlohn?.value).toMatch(/48/);
      const clauseIds = new Set((result!.clauses ?? []).map((clause) => clause.id));
      expect(clauseIds.has('stundenlohnarbeiten')).toBe(false);
    });

    it('mehrere Datum-Angaben: nur Vertragsdatum zählt', () => {
      const text = `
Werkvertrag
Auftraggeber: Beispiel AG
Auftragnehmer: Beispiel AN
Angebotsdatum: 01.01.2026
Rechnungsdatum: 15.02.2026
Vertragsdatum: 20.03.2026
`.trim();
      const result = analyzeContractIntelligenceFromText(text);
      expect(result!.contractFields.vertragsdatum?.value).toContain('20.03.2026');
      expect(result!.contractFields.vertragsdatum?.value).not.toContain('01.01.2026');
    });

    it('allgemeine Leistung ohne Bauvorhaben bleibt leer', () => {
      const text = `
Dienstleistungsvertrag
Auftraggeber: Kunde AG
Dienstleister: Service GmbH
Leistung: allgemeine Beratung
Laufzeit: 12 Monate
`.trim();
      const result = analyzeContractIntelligenceFromText(text);
      expect(result!.contractFields.bauvorhaben?.status ?? 'not_found').toBe('not_found');
    });
  });
});
