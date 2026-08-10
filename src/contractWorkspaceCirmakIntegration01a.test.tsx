/**
 * CONTRACT-REVIEW-UI-01A — Integrationstest über den echten Produktionspfad.
 *
 * OCR-Text → analyzeContractIntelligenceFromText → buildContractOrderProposal
 * → buildContractWorkspaceSummaryView → ContractWorkspaceSummary → HTML.
 *
 * Nachbau des Falls Werkvertrag_Test_Cirmak_NordWest_13b_8_Seiten.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { t, type TranslationKey } from './i18n';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './services/contractIntelligenceService';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { createAuftragInboxItem } from './test/fixtures';

const translate = (key: TranslationKey) => t(key, 'de');

/**
 * Seitentext wie er real ankommt: pdfDocumentService fügt alle Text-Items einer
 * Seite mit Leerzeichen zusammen, sodass §6 bis §8 in einer einzigen Zeile landen.
 */
const CIRMAK_OCR = `
Werkvertrag (Bauleistung nach VOB/B)

Auftraggeber: NordWest Dachbau GmbH
Carl-Bertelsmann-Straße 211, 33335 Gütersloh

Auftragnehmer: Cirmak Haustechnik GmbH

Vertragsdatum: 09.08.2026
Bauvorhaben: Neubau Verwaltungsgebäude, 3. Bauabschnitt
Baustelle: Carl-Bertelsmann-Straße 211, 33335 Gütersloh

§ 5 Vergütung
Gesamtsumme netto 34.624,00 €

§ 6 Ausführungsfristen Geplanter Ausführungsbeginn: 31.08.2026 Geplantes Ausführungsende: 18.09.2026 Zwischentermine werden mit der Bauleitung abgestimmt. Änderungen des Bauablaufs sind frühzeitig mitzuteilen. § 7 Behinderungen und Unterbrechungen Behinderungen, fehlende Vorleistungen oder sonstige Umstände sind unverzüglich anzuzeigen. § 8 Nachträge Nachträge bedürfen der Schriftform.

Zahlungsbedingungen: 14 Kalendertage nach Rechnungseingang
Gewährleistung: 4 Jahre ab Abnahme
`.trim();

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('CONTRACT-REVIEW-UI-01A – Produktionspfad Cirmak/NordWest', () => {
  const result = analyzeContractIntelligenceFromText(CIRMAK_OCR);
  const item = createAuftragInboxItem({
    id: 'inbox-cirmak-01a',
    ocrText: CIRMAK_OCR,
  });
  const proposal = buildContractOrderProposal(item, result);

  it('baut ein Proposal aus dem echten Extraktionsergebnis', () => {
    expect(proposal).not.toBeNull();
  });

  it('rendert Beginn und Ende ohne Klauseltext', () => {
    const view = buildContractWorkspaceSummaryView(proposal!, { item });
    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal: proposal!, translate, item }),
    );
    const text = visibleText(html);

    // Datenherkunft protokollieren, damit ein Fehlschlag die Quelle zeigt.
    const herkunft = {
      contractFieldsBeginn: result.contractFields.beginn?.value,
      contractFieldsEnde: result.contractFields.ende?.value,
      commonFieldsBeginn: result.commonFields?.beginn?.value,
      commonFieldsEnde: result.commonFields?.ende?.value,
      typeSpecific: Object.keys(result.typeSpecificFields ?? {}),
      deadlineFact: view.deadlineFact,
      factRowsBeginnEnde: view.factRows.filter((r) => r.id === 'beginn' || r.id === 'ende'),
      overviewRows: view.overviewRows,
    };

    expect({ herkunft, contains: {
      behinderungen: text.includes('Behinderungen'),
      zwischentermine: text.includes('Zwischentermine'),
      bauablauf: text.includes('Bauablauf'),
      ausfuehrungsende: text.includes('Geplantes Ausführungsende'),
    } }).toMatchObject({ contains: {
      behinderungen: false,
      zwischentermine: false,
      bauablauf: false,
      ausfuehrungsende: false,
    } });

    expect(text).toContain('31.08.2026');
    expect(text).toContain('18.09.2026');
    // 01B: eindeutig erkannte Daten dürfen nicht als prüfbedürftig erscheinen.
    expect(view.deadlineFact?.needsReview).toBe(false);
    expect(view.factRows.find((row) => row.id === 'ende')?.needsReview).toBe(false);
    expect(text).not.toContain(translate('documentIntelligence.workspace.needsReview'));
    expect(text).toContain('14 Kalendertage nach Rechnungseingang');
    expect(text).toContain('4 Jahre ab Abnahme');
  });
});
