import type { ReactNode } from 'react';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftMetadataChanges } from '../../types/models';
import { hasPrivateRetentionNotice } from '../../services/invoiceTaxService';

interface Props {
  draft: InvoiceDraft;
  onChange: (changes: InvoiceDraftMetadataChanges) => void;
  /**
   * CUSTOMER-FACHOBJEKT-05B — optional block above the customer fields that
   * offers taking over the customer master data. Rendered by the page; this
   * component stays pure presentation and knows no service.
   */
  customerMaster?: ReactNode;
  /**
   * CLOUD-SYNC S5 — sichtbar gesperrt, solange der Editor keine Änderung
   * annimmt (z. B. offener Cloud-Konflikt bis zur Entscheidung).
   */
  disabled?: boolean;
  /**
   * FINANZ-CORE-01A (RE-16) — die Rechnung hängt an einem Auftrag. Ohne Auftrag (freie
   * Rechnung) sprach der Hinweis zum Fälligkeitsdatum trotzdem von „diesem Auftrag".
   */
  withOrder?: boolean;
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

export function InvoiceDraftEditForm({ draft, onChange, customerMaster, disabled = false, withOrder = true }: Props) {
  const billing = draft.customerBilling;

  /*
   * INVOICE-SERVICE-PERIOD-01B — eine bewusste Datumseingabe ist die
   * Bestätigung. Sobald beide Felder gefüllt sind, gilt der Zeitraum als
   * gesetzt; wird eines geleert, ist er es nicht mehr.
   *
   * Die Entscheidung fällt hier im Oberflächenpfad, nicht im generischen
   * Setter — sonst würde sich ein späterer Systemvorschlag selbst bestätigen.
   */
  const changeServicePeriod = (changes: InvoiceDraftMetadataChanges) => {
    const from = changes.servicePeriodFrom ?? draft.servicePeriodFrom;
    const to = changes.servicePeriodTo ?? draft.servicePeriodTo;
    onChange({ ...changes, servicePeriodConfirmed: Boolean(from.trim() && to.trim()) });
  };

  return (
    <form className="invoice-edit" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="invoice-edit__section" disabled={disabled}>
        <legend>Rechnungsdaten</legend>
        <Field label="Rechnungsdatum">
          <input
            type="date"
            className="input"
            value={draft.issueDate}
            data-testid="invoice-edit-issue-date"
            onChange={(event) => onChange({ issueDate: event.target.value })}
          />
        </Field>
        <div className="form-row">
          <Field label="Leistungszeitraum von">
            <input
              type="date"
              className="input"
              value={draft.servicePeriodFrom}
              data-testid="invoice-edit-service-from"
              onChange={(event) => changeServicePeriod({ servicePeriodFrom: event.target.value })}
            />
          </Field>
          <Field label="Leistungszeitraum bis">
            <input
              type="date"
              className="input"
              value={draft.servicePeriodTo}
              data-testid="invoice-edit-service-to"
              onChange={(event) => changeServicePeriod({ servicePeriodTo: event.target.value })}
            />
          </Field>
        </div>
        <Field label="Zahlungsziel">
          <input
            type="date"
            className="input"
            value={draft.paymentDueDate}
            data-testid="invoice-edit-payment-due"
            onChange={(event) => onChange({ paymentDueDate: event.target.value })}
          />
          {/*
            AUFTRAG-02C2 — Trägt der Auftrag eigene Zahlungsbedingungen, bleibt
            das Fälligkeitsdatum leer: Aus „innerhalb von 21 Tagen" ein Datum zu
            raten wäre erfunden. Der Hinweis sagt, warum hier nichts steht.
          */}
          {!draft.paymentDueDate?.trim() && draft.paymentTermsText?.trim() ? (
            <p className="form-hint" data-testid="invoice-edit-payment-due-hint">
              {withOrder
                ? 'Dieser Auftrag hat eigene Zahlungsbedingungen. Bitte das Fälligkeitsdatum passend dazu eintragen.'
                : 'Es gilt der Zahlungstext. Bitte das Fälligkeitsdatum passend dazu eintragen.'}
            </p>
          ) : null}
        </Field>
        <Field label="Zahlungstext">
          <textarea
            className="input invoice-edit__textarea"
            value={draft.paymentTermsText}
            onChange={(event) => onChange({ paymentTermsText: event.target.value })}
            rows={3}
            data-testid="invoice-edit-payment-terms"
          />
        </Field>
        <Field label="Skonto">
          <input
            type="text"
            className="input"
            value={draft.skontoText}
            data-testid="invoice-edit-skonto"
            onChange={(event) => onChange({ skontoText: event.target.value })}
          />
        </Field>
        {/*
          FINANZ-CORE-01A (Feiertage, § 193 BGB) — nur bei einer ausdrücklich abweichenden Vereinbarung
          mit dem Kunden: Zahlungsziel und Skontofrist enden dann kalendarisch, ohne Verschiebung über
          Samstag, Sonntag oder Feiertag. Standard ist aus; mit der Freigabe eingefroren.
        */}
        <label className="edit-field edit-field--checkbox" data-testid="invoice-edit-deadline-shift-waived-field">
          <input
            type="checkbox"
            checked={draft.deadlineShiftWaived === true}
            onChange={(event) => onChange({ deadlineShiftWaived: event.target.checked })}
            data-testid="invoice-edit-deadline-shift-waived"
          />
          <span>Abweichend vereinbart: Fristen enden kalendarisch, auch an Samstag, Sonntag oder Feiertag</span>
        </label>
        {/*
          FINANZ-CORE-01A (AUS-11/EIN-07) — § 14 Abs. 4 Satz 1 Nr. 9 UStG: Leistung an einem
          Grundstück für eine Privatperson → Hinweis auf deren Aufbewahrungspflicht.
        */}
        <label className="edit-field edit-field--checkbox" data-testid="invoice-edit-private-retention-field">
          <input
            type="checkbox"
            checked={hasPrivateRetentionNotice(draft.legalNotices)}
            onChange={(event) => onChange({ privateRetentionNotice: event.target.checked })}
            data-testid="invoice-edit-private-retention"
          />
          <span>Privatkunde, Leistung an einem Grundstück: Hinweis auf die zweijährige Aufbewahrungspflicht drucken</span>
        </label>
      </fieldset>

      <fieldset className="invoice-edit__section" disabled={disabled}>
        <legend>Kunde</legend>
        {customerMaster}
        <Field label="Firma">
          <input
            type="text"
            className="input"
            data-testid="invoice-edit-customer-name"
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
            data-testid="invoice-edit-customer-contactPerson"
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
            data-testid="invoice-edit-customer-street"
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
              data-testid="invoice-edit-customer-zip"
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
              data-testid="invoice-edit-customer-city"
              value={billing.city}
              onChange={(event) =>
                onChange({ customerBilling: { city: event.target.value } })
              }
            />
          </Field>
        </div>
        <Field label="E-Mail">
          <input
            type="text"
            className="input"
            data-testid="invoice-edit-customer-email"
            value={billing.email}
            onChange={(event) =>
              onChange({ customerBilling: { email: event.target.value } })
            }
          />
        </Field>
        <Field label="Telefon">
          <input
            type="text"
            className="input"
            data-testid="invoice-edit-customer-phone"
            value={billing.phone}
            onChange={(event) =>
              onChange({ customerBilling: { phone: event.target.value } })
            }
          />
        </Field>
        {/*
          * E-RECHNUNG-04B — die Käuferreferenz dieser Rechnung.
          *
          * Vorbelegt aus dem Kundenstamm, hier bewusst änderbar: Zwei
          * Rechnungen an denselben Kunden dürfen verschiedene Referenzen
          * tragen, und der freigegebene Beleg behält seine für immer.
          *
          * Die Leitweg-ID steht absichtlich **nicht** daneben. Sie ist eine
          * Eigenschaft des Empfängers, nicht dieses Belegs; sie reist im
          * Snapshot mit und gehört in den Kundenstamm. Zwei ähnlich aussehende
          * Felder nebeneinander würden nur die Frage aufwerfen, welches von
          * beiden auf der Rechnung landet.
          */}
        <Field label="Käuferreferenz (für E-Rechnung, optional)">
          <input
            type="text"
            className="input"
            data-testid="invoice-edit-buyer-reference"
            value={billing.buyerReference ?? ''}
            onChange={(event) =>
              onChange({ customerBilling: { buyerReference: event.target.value } })
            }
          />
        </Field>
      </fieldset>

      <fieldset className="invoice-edit__section" disabled={disabled}>
        <legend>Bauvorhaben</legend>
        <Field label="Titel">
          <input
            type="text"
            className="input"
            value={draft.vorgangTitle ?? ''}
            data-testid="invoice-edit-title"
            onChange={(event) => onChange({ projectTitle: event.target.value })}
          />
        </Field>
        <Field label="Baustelle">
          <input
            type="text"
            className="input"
            value={draft.baustelle}
            data-testid="invoice-edit-baustelle"
            onChange={(event) => onChange({ projectSite: event.target.value })}
          />
        </Field>
      </fieldset>

      <fieldset className="invoice-edit__section" disabled={disabled}>
        <legend>Texte</legend>
        <Field label="Einleitungstext">
          <textarea
            className="input invoice-edit__textarea"
            value={draft.introText}
            onChange={(event) => onChange({ introText: event.target.value })}
            rows={4}
            data-testid="invoice-edit-intro"
          />
        </Field>
        <Field label="Schlusstext">
          <textarea
            className="input invoice-edit__textarea"
            value={draft.closingText}
            onChange={(event) => onChange({ closingText: event.target.value })}
            rows={4}
            data-testid="invoice-edit-closing"
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
