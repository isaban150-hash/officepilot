import { usesAbschlagDeductions } from '../../services/invoiceTypeService';
import type { InvoicePrintModel } from '../../types/models';
import { formatInvoiceCurrency } from '../../services/invoicePrintModel';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceSummary({ model }: Props) {
  const { summary, type } = model;
  const isSchluss = usesAbschlagDeductions(type) && summary.deductionLines.length > 0;

  return (
    <section className="invoice-block invoice-summary">
      <h2 className="invoice-block__title">Summen</h2>
      <dl className="invoice-summary__rows">
        <div className="invoice-summary__row">
          <dt>Netto</dt>
          <dd>{formatInvoiceCurrency(summary.subtotalNet)}</dd>
        </div>
        {summary.taxRate > 0 && (
          <div className="invoice-summary__row">
            <dt>MwSt. ({summary.taxRate} %)</dt>
            <dd>{formatInvoiceCurrency(summary.taxAmount)}</dd>
          </div>
        )}
        <div className="invoice-summary__row invoice-summary__row--emphasis">
          <dt>{isSchluss ? 'Zwischensumme (brutto)' : 'Brutto'}</dt>
          <dd>{formatInvoiceCurrency(summary.grossTotal)}</dd>
        </div>

        {isSchluss && (
          <>
            <div className="invoice-summary__deductions">
              <p className="invoice-summary__deductions-title">Bereits berechnet</p>
              {summary.deductionLines.map((line) => (
                <div key={`${line.label}-${line.invoiceNumber}`} className="invoice-summary__row">
                  <dt>
                    {line.label}
                    <span className="invoice-summary__deduction-ref"> ({line.invoiceNumber})</span>
                    {/* FINANZ-CORE-01A (WEISS-Recheck N02-R1) — mit Skonto beglichen: nur der gezahlte Teil. */}
                    {line.paidPart ? <span className="invoice-summary__deduction-paid">, gezahlt</span> : null}
                    {/*
                      * FINANZ-CORE-01A (AUS-01 / WEISS-Nacharbeit N13) — wie im PDF: § 14 Abs. 5 S. 2 UStG
                      * verlangt die abgesetzten Teilentgelte und die auf sie entfallende Steuer.
                      */}
                    {line.netAmount !== undefined && line.taxAmount !== undefined && line.taxAmount !== 0 ? (
                      <span className="invoice-summary__deduction-parts">
                        {` (netto ${formatInvoiceCurrency(line.netAmount)}, USt ${formatInvoiceCurrency(line.taxAmount)})`}
                      </span>
                    ) : null}
                  </dt>
                  {/* FINANZ-CORE-01A (AUS-17) — im Korrekturbeleg ist der Abzug negiert: „+" statt „− −". */}
                  <dd>{line.amount < 0 ? `+ ${formatInvoiceCurrency(-line.amount)}` : <>− {formatInvoiceCurrency(line.amount)}</>}</dd>
                </div>
              ))}
              {/*
                * FINANZ-CORE-01A (WEISS-Recheck N02-R1) — das gewährte Skonto als eigene Zeile
                * (Entgeltminderung), mit Netto und Steuer — dieselbe Aufteilung wie PDF und E-Rechnung.
                */}
              {(summary.skontoLines ?? []).map((line) => (
                <div key={`skonto-${line.label}-${line.invoiceNumber}`} className="invoice-summary__row invoice-summary__row--skonto">
                  <dt>
                    {line.label}
                    <span className="invoice-summary__deduction-ref"> ({line.invoiceNumber})</span>
                    {line.netAmount !== undefined && line.taxAmount !== undefined && line.taxAmount !== 0 ? (
                      <span className="invoice-summary__deduction-parts">
                        {` (netto ${formatInvoiceCurrency(line.netAmount)}, USt ${formatInvoiceCurrency(line.taxAmount)})`}
                      </span>
                    ) : null}
                  </dt>
                  <dd>{line.amount < 0 ? `+ ${formatInvoiceCurrency(-line.amount)}` : <>− {formatInvoiceCurrency(line.amount)}</>}</dd>
                </div>
              ))}
              <div className="invoice-summary__row">
                <dt>
                  Summe Abschläge
                  {summary.deductionsNetTotal !== undefined &&
                  summary.deductionsTaxTotal !== undefined &&
                  summary.deductionsTaxTotal !== 0 ? (
                    <span className="invoice-summary__deduction-parts">
                      {` (netto ${formatInvoiceCurrency(summary.deductionsNetTotal)}, USt ${formatInvoiceCurrency(summary.deductionsTaxTotal)})`}
                    </span>
                  ) : null}
                </dt>
                <dd>
                  {summary.deductionsTotal < 0 ? `+ ${formatInvoiceCurrency(-summary.deductionsTotal)}` : <>− {formatInvoiceCurrency(summary.deductionsTotal)}</>}
                </dd>
              </div>
            </div>
            <div className="invoice-summary__row invoice-summary__row--total">
              <dt>Restbetrag</dt>
              <dd>{formatInvoiceCurrency(summary.amountDue)}</dd>
            </div>
          </>
        )}

        {!isSchluss && summary.taxRate === 0 && (
          <div className="invoice-summary__row invoice-summary__row--total">
            <dt>Gesamtbetrag</dt>
            <dd>{formatInvoiceCurrency(summary.amountDue)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
