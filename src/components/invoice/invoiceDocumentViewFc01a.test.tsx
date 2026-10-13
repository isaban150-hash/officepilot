/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N13/N14, WEISS-Recheck N02-R1) — HTML-Ansicht der Rechnung.
 * Angelegt nach der ausdrücklichen Freigabe der Snapshot-Änderung (12.10.2026).
 *
 *  H1  Kopf und Fuß nennen die Firma einmal — „Muster Handwerk GmbH", nie „GmbH GmbH"
 *  H2  Schlussrechnung: je abgezogenem Abschlag Netto und Umsatzsteuer, dazu die Summe
 *      (§ 14 Abs. 5 S. 2 UStG; dieselben Beträge wie PDF und E-Rechnung)
 *  H3  ohne Abzüge keine Aufschlüsselung
 *  H4  mit Skonto beglichener Abschlag: gezahlter Teil und Skonto als eigene Zeile — dieselbe
 *      Aufteilung wie PDF und E-Rechnung; „Summe Abschläge" und Restbetrag unverändert
 *
 * Bewusst ohne toMatchSnapshot: Der geschützte Snapshot bleibt die einzige Snapshot-Quelle.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { InvoiceDocumentView } from './InvoiceDocumentView';
import { buildInvoicePrintModel } from '../../services/invoicePrintModel';
import { createNormalPrintSetup, createSchlussPrintSetup } from '../../test/invoicePrintFixtures';

function renderInvoice(model: ReturnType<typeof buildInvoicePrintModel>): string {
  return renderToStaticMarkup(
    <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
      <InvoiceDocumentView model={model} />
    </AppProvider>,
  );
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ');
}

describe('FINANZ-CORE-01A — HTML-Ansicht der Rechnung (N13/N14, N02-R1)', () => {
  it('H1: die Firma steht einmal mit Rechtsform', () => {
    const { draft, setup } = createNormalPrintSetup();
    const sichtbar = text(renderInvoice(buildInvoicePrintModel(draft, setup)));
    expect(sichtbar).not.toMatch(/GmbH\s+GmbH/);
    expect(sichtbar).toContain('Muster Handwerk GmbH');
  });

  it('H2: Schlussrechnung schlüsselt jeden Abschlag nach Netto und Umsatzsteuer auf', () => {
    const { draft, setup } = createSchlussPrintSetup();
    const sichtbar = text(renderInvoice(buildInvoicePrintModel(draft, setup)));
    expect(sichtbar).toContain('(netto 260,00 €, USt 49,40 €)');
    expect(sichtbar).toContain('(netto 130,00 €, USt 24,70 €)');
    expect(sichtbar).toContain('(netto 65,00 €, USt 12,35 €)');
    expect(sichtbar).toContain('Summe Abschläge (netto 455,00 €, USt 86,45 €)');
  });

  it('H3: ohne Abzüge keine Aufschlüsselung', () => {
    const { draft, setup } = createNormalPrintSetup();
    expect(renderInvoice(buildInvoicePrintModel(draft, setup))).not.toContain('invoice-summary__deduction-parts');
  });

  it('H4: mit Skonto beglichener Abschlag — gezahlt und Skonto getrennt, Restbetrag unverändert', () => {
    const { draft, setup } = createSchlussPrintSetup();
    const ohneSkonto = buildInvoicePrintModel(draft, setup);
    // Abschlag 1 (309,40 €) fristgerecht mit 2 % Skonto beglichen: 303,21 € gezahlt, 6,19 € Skonto.
    const model = buildInvoicePrintModel(draft, setup, {
      settlementOf: (deduction) => (deduction.invoiceId === 'inv-1' ? { paid: 303.21, skonto: 6.19 } : null),
    });
    const html = renderInvoice(model);
    const sichtbar = text(html);
    expect(sichtbar).toContain('Abschlag 1 (2026-0001) , gezahlt (netto 254,80 €, USt 48,41 €) − 303,21 €');
    expect(sichtbar).toContain('Skonto auf Abschlag 1 (2026-0001) (netto 5,20 €, USt 0,99 €) − 6,19 €');
    expect(html.match(/invoice-summary__row--skonto/g)).toHaveLength(1);
    // Abschläge 2 und 3 wie abgerechnet; Summe und Restbetrag wie ohne Skonto.
    expect(sichtbar).toContain('(netto 130,00 €, USt 24,70 €) − 154,70 €');
    expect(sichtbar).toContain('Summe Abschläge (netto 455,00 €, USt 86,45 €) − 541,45 €');
    expect(model.summary.amountDue).toBe(ohneSkonto.summary.amountDue);
    expect(sichtbar).toContain(`Restbetrag ${text(`${ohneSkonto.summary.amountDue.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`).trim()}`);
  });
});
