import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceDocumentView } from './InvoiceDocumentView';
import { buildInvoicePrintModel } from '../../services/invoicePrintModel';
import {
  buildPrintModelFromDraft,
  createEmptyPositionsPrintSetup,
  createKleinunternehmerPrintSetup,
  createNormalPrintSetup,
  createReverseChargePrintSetup,
  createSchlussPrintSetup,
} from '../../test/invoicePrintFixtures';

function renderInvoice(model: ReturnType<typeof buildInvoicePrintModel>): string {
  return renderToStaticMarkup(<InvoiceDocumentView model={model} />);
}

describe('InvoiceDocumentView snapshots', () => {
  it('renders normal invoice', () => {
    const { draft, setup } = createNormalPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);
    expect(renderInvoice(model)).toMatchSnapshot();
  });

  it('renders schlussrechnung with abschlag deductions', () => {
    const { draft, setup } = createSchlussPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);
    const html = renderInvoice(model);
    expect(html).toContain('Bereits berechnet');
    expect(html).toContain('Abschlag 1');
    expect(html).toContain('Abschlag 2');
    expect(html).toContain('Abschlag 3');
    expect(html).toContain('Restbetrag');
    expect(html).toMatchSnapshot();
  });

  it('renders §19 kleinunternehmer notice', () => {
    const { draft, setup } = createKleinunternehmerPrintSetup();
    const model = buildPrintModelFromDraft(draft, setup);
    const html = renderInvoice(model);
    expect(html).toContain('§19 Kleinunternehmer');
    expect(html).toContain('§ 19 UStG');
    expect(html).toMatchSnapshot();
  });

  it('renders §13b reverse charge notice', () => {
    const { draft, setup } = createReverseChargePrintSetup();
    const model = buildPrintModelFromDraft(draft, setup);
    const html = renderInvoice(model);
    expect(html).toContain('§13b Reverse Charge');
    expect(html).toContain('§ 13b UStG');
    expect(html).toMatchSnapshot();
  });

  it('renders invoice without billable positions', () => {
    const { draft, setup } = createEmptyPositionsPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);
    const html = renderInvoice(model);
    expect(html).toContain('Keine Positionen auf dieser Rechnung.');
    expect(html).toMatchSnapshot();
  });

  it('includes desktop table and mobile cards for responsive layout', () => {
    const { draft, setup } = createNormalPrintSetup();
    const model = buildInvoicePrintModel(draft, setup);
    const html = renderInvoice(model);
    expect(html).toContain('invoice-positions__table');
    expect(html).toContain('invoice-positions__cards');
    expect(html).toContain('invoice-positions__card');
  });
});
