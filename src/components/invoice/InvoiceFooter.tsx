import type { InvoicePrintModel } from '../../types/models';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceFooter({ model }: Props) {
  if (!model.footerNotes.trim()) {
    return null;
  }

  return (
    <footer className="invoice-footer">
      <p>{model.footerNotes}</p>
    </footer>
  );
}
