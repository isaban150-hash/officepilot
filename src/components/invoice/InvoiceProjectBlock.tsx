import type { InvoicePrintModel } from '../../types/models';

interface Props {
  model: InvoicePrintModel;
}

/**
 * MANUAL-INVOICE-01B2c — der Block existiert nur, wenn es ein Bauvorhaben
 * gibt. Eine Rechnung ohne Auftrag trägt weder Titel noch Baustelle; dann
 * erscheint hier nichts — kein „—", kein „Unbekannt", keine leere Zeile.
 * Für Auftragsrechnungen ändert sich nichts.
 */
export function InvoiceProjectBlock({ model }: Props) {
  const title = model.projectTitle?.trim() ?? '';
  const site = model.projectSite?.trim() ?? '';
  if (!title && !site) return null;

  return (
    <section className="invoice-block invoice-project">
      <h2 className="invoice-block__title">Bauvorhaben</h2>
      <dl className="invoice-project__facts">
        {title && (
          <div>
            <dt>Titel</dt>
            <dd>{model.projectTitle}</dd>
          </div>
        )}
        {site && (
          <div>
            <dt>Baustelle</dt>
            <dd>{model.projectSite}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
