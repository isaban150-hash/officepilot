import type { ReactNode } from 'react';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftMetadataChanges } from '../../types/models';

interface Props {
  draft: InvoiceDraft;
  onChange: (changes: InvoiceDraftMetadataChanges) => void;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="invoice-edit__field">
      <span className="invoice-edit__label">{label}</span>
      {children}
    </label>
  );
}

export function InvoiceDraftEditForm({ draft, onChange }: Props) {
  const billing = draft.customerBilling;

  return (
    <form className="invoice-edit" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="invoice-edit__section">
        <legend>Rechnungsdaten</legend>
        <Field label="Rechnungsdatum">
          <input
            type="date"
            className="input"
            value={draft.issueDate}
            onChange={(event) => onChange({ issueDate: event.target.value })}
          />
        </Field>
        <div className="form-row">
          <Field label="Leistungszeitraum von">
            <input
              type="date"
              className="input"
              value={draft.servicePeriodFrom}
              onChange={(event) => onChange({ servicePeriodFrom: event.target.value })}
            />
          </Field>
          <Field label="Leistungszeitraum bis">
            <input
              type="date"
              className="input"
              value={draft.servicePeriodTo}
              onChange={(event) => onChange({ servicePeriodTo: event.target.value })}
            />
          </Field>
        </div>
        <Field label="Zahlungsziel">
          <input
            type="date"
            className="input"
            value={draft.paymentDueDate}
            onChange={(event) => onChange({ paymentDueDate: event.target.value })}
          />
        </Field>
        <Field label="Zahlungstext">
          <textarea
            className="input invoice-edit__textarea"
            value={draft.paymentTermsText}
            onChange={(event) => onChange({ paymentTermsText: event.target.value })}
            rows={3}
          />
        </Field>
        <Field label="Skonto">
          <input
            type="text"
            className="input"
            value={draft.skontoText}
            onChange={(event) => onChange({ skontoText: event.target.value })}
          />
        </Field>
      </fieldset>

      <fieldset className="invoice-edit__section">
        <legend>Kunde</legend>
        <Field label="Firma">
          <input
            type="text"
            className="input"
            value={billing.name}
            onChange={(event) =>
              onChange({ customerBilling: { name: event.target.value } })
            }
          />
        </Field>
        <Field label="Ansprechpartner">
          <input
            type="text"
            className="input"
            value={billing.contactPerson}
            onChange={(event) =>
              onChange({ customerBilling: { contactPerson: event.target.value } })
            }
          />
        </Field>
        <Field label="Straße">
          <input
            type="text"
            className="input"
            value={billing.street}
            onChange={(event) =>
              onChange({ customerBilling: { street: event.target.value } })
            }
          />
        </Field>
        <div className="form-row">
          <Field label="PLZ">
            <input
              type="text"
              className="input"
              value={billing.zip}
              onChange={(event) =>
                onChange({ customerBilling: { zip: event.target.value } })
              }
            />
          </Field>
          <Field label="Ort">
            <input
              type="text"
              className="input"
              value={billing.city}
              onChange={(event) =>
                onChange({ customerBilling: { city: event.target.value } })
              }
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="invoice-edit__section">
        <legend>Bauvorhaben</legend>
        <Field label="Titel">
          <input
            type="text"
            className="input"
            value={draft.vorgangTitle}
            onChange={(event) => onChange({ projectTitle: event.target.value })}
          />
        </Field>
        <Field label="Baustelle">
          <input
            type="text"
            className="input"
            value={draft.baustelle}
            onChange={(event) => onChange({ projectSite: event.target.value })}
          />
        </Field>
      </fieldset>

      <fieldset className="invoice-edit__section">
        <legend>Texte</legend>
        <Field label="Einleitungstext">
          <textarea
            className="input invoice-edit__textarea"
            value={draft.introText}
            onChange={(event) => onChange({ introText: event.target.value })}
            rows={4}
          />
        </Field>
        <Field label="Schlusstext">
          <textarea
            className="input invoice-edit__textarea"
            value={draft.closingText}
            onChange={(event) => onChange({ closingText: event.target.value })}
            rows={4}
          />
        </Field>
      </fieldset>

      <p className="invoice-edit__locked hint-text">
        Nicht editierbar: Rechnungsnummer, Firmendaten (Snapshot), bereits fakturierte Mengen und
        gesperrte Preise.
      </p>
    </form>
  );
}
