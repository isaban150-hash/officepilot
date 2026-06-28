import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Badge, Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import { getInvoiceGrossAmount, isFinalizedInvoice } from '../../services/invoiceArchiveService';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  vorgangId: string;
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
}

function invoiceLabel(inv: VorgangInvoice, translate: (key: TranslationKey) => string): string {
  if (inv.type === 'schluss') {
    return translate('invoice.schlussLabel');
  }
  return `${translate('invoice.abschlagLabel')} ${inv.abschlagNumber ?? '?'}`;
}

function statusLabel(status: VorgangInvoice['status'], translate: (key: TranslationKey) => string): string {
  const key = `invoice.status.${status}` as TranslationKey;
  return translate(key);
}

export function InvoiceListCard({ vorgangId, invoice, translate }: Props) {
  const navigate = useNavigate();
  const grossAmount = getInvoiceGrossAmount(invoice);
  const readOnly = isFinalizedInvoice(invoice);

  const openInvoice = () => {
    navigate(`/vorgaenge/${vorgangId}/rechnungen/${invoice.id}`);
  };

  const triggerPrint = () => {
    if (!readOnly) return;
    navigate(`/vorgaenge/${vorgangId}/rechnungen/${invoice.id}?auto=print`);
  };

  const triggerPdf = () => {
    if (!readOnly) return;
    navigate(`/vorgaenge/${vorgangId}/rechnungen/${invoice.id}?auto=pdf`);
  };

  return (
    <Card className="invoice-list-card">
      <CardTitle>{invoiceLabel(invoice, translate)}</CardTitle>
      <CardMeta>
        {invoice.number} · {formatInvoiceDate(invoice.issueDate ?? invoice.date)}
      </CardMeta>
      <DataRow label={translate('invoice.taxStatus')} value={statusLabel(invoice.status, translate)} />
      <DataRow
        label={translate('invoice.grossAmount')}
        value={`${grossAmount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
      />
      {invoice.archiveDocumentId && (
        <p className="invoice-list-card__archive">
          <Link to={`/dokumente/${invoice.archiveDocumentId}`}>
            {translate('invoice.openArchiveDocument')}
          </Link>
        </p>
      )}
      {readOnly ? (
        <div className="invoice-list-card__actions">
          <Button type="button" onClick={openInvoice}>
            {translate('invoice.open')}
          </Button>
          <Button type="button" variant="outline" onClick={triggerPrint}>
            {translate('invoice.print')}
          </Button>
          <Button type="button" variant="outline" onClick={triggerPdf}>
            {translate('invoice.savePdf')}
          </Button>
        </div>
      ) : (
        <Badge tone="warning">{translate('invoice.status.entwurf')}</Badge>
      )}
    </Card>
  );
}
