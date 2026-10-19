/**
 * CUSTOMER-FACHOBJEKT-05A — customer master data form.
 *
 * Pure presentation: local state only, no service call, no store access and no
 * persistence. Saving happens exclusively through the onSave callback, never
 * while typing. The technical customer id is never rendered as visible text.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { Customer, CustomerBilling, CustomerHolidayLocation } from '../../types/models';
import { BUNDESLAENDER, BUNDESLAND_NAMEN } from '../../services/fristen/feiertage';
import { laenderFuerPlz, normalizeHolidayLocation } from '../../services/fristen/fristende';

/**
 * E-RECHNUNG-04B — die Stammdaten, die eine spätere strukturierte Rechnung
 * braucht, stehen im selben Formular. Keine zweite Kundenseite: Es sind
 * Angaben zum Kunden, keine Angaben zu einem Verfahren.
 */
export type CustomerEditValues = CustomerBilling & {
  buyerReferenceDefault: string;
  /** FINANZ-CORE-01A (Feiertage) — `null`: keine Angabe, das Bundesland folgt der PLZ. */
  holidayLocation: CustomerHolidayLocation | null;
};

interface CustomerEditFormProps {
  customer: Customer;
  busy: boolean;
  error: string | null;
  onSave: (changes: CustomerEditValues) => void;
  onCancel: () => void;
}

function valuesOf(customer: Customer): CustomerEditValues {
  return {
    name: customer.name,
    contactPerson: customer.contactPerson,
    street: customer.street,
    zip: customer.zip,
    city: customer.city,
    email: customer.email,
    phone: customer.phone,
    // Leerer Text im Formular, Abwesenheit im Datensatz — der Dienst wandelt um.
    countryCode: customer.countryCode ?? '',
    vatId: customer.vatId ?? '',
    buyerReferenceDefault: customer.buyerReferenceDefault ?? '',
    leitwegId: customer.leitwegId ?? '',
    holidayLocation: normalizeHolidayLocation(customer.holidayLocation) ?? null,
  };
}

/** Dreiwertige Auswahl für einen Gemeindefeiertag: ungeklärt (fehlt), ja, nein. */
function triValue(value: boolean | undefined): string {
  return value === true ? 'ja' : value === false ? 'nein' : '';
}

function fromTri(value: string): boolean | undefined {
  return value === 'ja' ? true : value === 'nein' ? false : undefined;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="invoice-edit__field">
      <span className="invoice-edit__label">{label}</span>
      {children}
    </label>
  );
}

export function CustomerEditForm({
  customer,
  busy,
  error,
  onSave,
  onCancel,
}: CustomerEditFormProps) {
  const { translate } = useApp();
  const [values, setValues] = useState<CustomerEditValues>(() => valuesOf(customer));

  // Switching to another customer loads that customer's values; nothing is carried over.
  useEffect(() => {
    setValues(valuesOf(customer));
  }, [customer.id]);

  const set = (field: Exclude<keyof CustomerEditValues, 'holidayLocation'>) => (value: string) =>
    setValues((prev) => ({ ...prev, [field]: value }));

  const setHoliday = (holidayLocation: CustomerHolidayLocation | null) =>
    setValues((prev) => ({ ...prev, holidayLocation }));

  // Was ohne Angabe gilt: die Länder des PLZ-Leitbereichs, im Ausland nichts Deutsches.
  const country = (values.countryCode ?? '').trim().toUpperCase();
  const fromZip = laenderFuerPlz(values.zip.trim());
  const automaticLabel =
    country && country !== 'DE'
      ? translate('customer.holiday.regionAutoAbroad')
      : fromZip
        ? translate('customer.holiday.regionAuto').replace(
            '{laender}',
            fromZip.laender.map((code) => BUNDESLAND_NAMEN[code]).join(' / '),
          )
        : translate('customer.holiday.regionAutoUnknown');

  const triSelect = (key: 'fronleichnam' | 'mariaeHimmelfahrt' | 'augsburgerFriedensfest', label: string) => (
    <Field label={label}>
      <select
        className="input"
        data-testid={`kunden-edit-holiday-${key}`}
        value={triValue(values.holidayLocation?.[key])}
        onChange={(event) => {
          const current = values.holidayLocation;
          if (!current) return;
          setHoliday(normalizeHolidayLocation({ ...current, [key]: fromTri(event.target.value) }) ?? null);
        }}
      >
        <option value="">{translate('customer.holiday.unknown')}</option>
        <option value="ja">{translate('customer.holiday.yes')}</option>
        <option value="nein">{translate('customer.holiday.no')}</option>
      </select>
    </Field>
  );

  return (
    <Card>
      <form
        className="invoice-edit"
        data-testid="kunden-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          onSave(values);
        }}
      >
        <fieldset className="invoice-edit__section" disabled={busy}>
          <legend>{translate('kunden.edit.title')}</legend>

          <Field label={translate('kunden.edit.name')}>
            <input
              className="input"
              data-testid="kunden-edit-name"
              value={values.name}
              onChange={(event) => set('name')(event.target.value)}
            />
          </Field>
          <Field label={translate('kunden.detail.contactPerson')}>
            <input
              className="input"
              data-testid="kunden-edit-contactPerson"
              value={values.contactPerson}
              onChange={(event) => set('contactPerson')(event.target.value)}
            />
          </Field>
          <Field label={translate('companyProfile.street')}>
            <input
              className="input"
              data-testid="kunden-edit-street"
              value={values.street}
              onChange={(event) => set('street')(event.target.value)}
            />
          </Field>
          <div className="form-row">
            <Field label={translate('companyProfile.zip')}>
              <input
                className="input"
                data-testid="kunden-edit-zip"
                value={values.zip}
                onChange={(event) => set('zip')(event.target.value)}
              />
            </Field>
            <Field label={translate('companyProfile.city')}>
              <input
                className="input"
                data-testid="kunden-edit-city"
                value={values.city}
                onChange={(event) => set('city')(event.target.value)}
              />
            </Field>
          </div>
          <Field label={translate('companyProfile.email')}>
            <input
              className="input"
              data-testid="kunden-edit-email"
              value={values.email}
              onChange={(event) => set('email')(event.target.value)}
            />
          </Field>
          <Field label={translate('companyProfile.phone')}>
            <input
              className="input"
              data-testid="kunden-edit-phone"
              value={values.phone}
              onChange={(event) => set('phone')(event.target.value)}
            />
          </Field>
        </fieldset>

        {/*
          * E-RECHNUNG-04B — Angaben, die erst eine strukturierte Rechnung
          * braucht. Bewusst als eigener Block und ausdrücklich als optional
          * beschriftet: Für eine normale PDF-Rechnung ändert sich nichts, und
          * niemand soll glauben, hier fehle etwas Pflichtiges.
          */}
        <fieldset className="invoice-edit__section" data-testid="kunden-edit-einvoice">
          <legend>{translate('customer.einvoice.section')}</legend>
          <p className="hint-text">{translate('customer.einvoice.hint')}</p>
          <Field label={translate('customer.einvoice.countryCode')}>
            <input
              className="input"
              data-testid="kunden-edit-country-code"
              value={values.countryCode ?? ''}
              onChange={(event) => set('countryCode')(event.target.value)}
            />
          </Field>
          <Field label={translate('customer.einvoice.vatId')}>
            <input
              className="input"
              data-testid="kunden-edit-vat-id"
              value={values.vatId ?? ''}
              onChange={(event) => set('vatId')(event.target.value)}
            />
          </Field>
          <Field label={translate('customer.einvoice.buyerReferenceDefault')}>
            <input
              className="input"
              data-testid="kunden-edit-buyer-reference"
              value={values.buyerReferenceDefault}
              onChange={(event) => set('buyerReferenceDefault')(event.target.value)}
            />
          </Field>
          <Field label={translate('customer.einvoice.leitwegId')}>
            <input
              className="input"
              data-testid="kunden-edit-leitweg-id"
              value={values.leitwegId ?? ''}
              onChange={(event) => set('leitwegId')(event.target.value)}
            />
          </Field>
        </fieldset>

        {/*
          * FINANZ-CORE-01A (Feiertage, § 193 BGB) — der Sitz des Kunden für Fristenden. Ohne Angabe
          * leitet OfficeTakt das Bundesland aus der PLZ ab; die Angabe hier geht vor und klärt
          * Grenz-PLZ, Gemeindefeiertage und Kunden im Ausland.
          */}
        <fieldset className="invoice-edit__section" data-testid="kunden-edit-holiday">
          <legend>{translate('customer.holiday.section')}</legend>
          <p className="hint-text">{translate('customer.holiday.hint')}</p>
          <Field label={translate('customer.holiday.region')}>
            <select
              className="input"
              data-testid="kunden-edit-holiday-region"
              value={values.holidayLocation?.region ?? ''}
              onChange={(event) => {
                const region = event.target.value;
                setHoliday(region ? (normalizeHolidayLocation({ region }) ?? null) : null);
              }}
            >
              <option value="">{automaticLabel}</option>
              {BUNDESLAENDER.map((code) => (
                <option key={code} value={code}>
                  {BUNDESLAND_NAMEN[code]}
                </option>
              ))}
              <option value="AUSLAND">{translate('customer.holiday.abroad')}</option>
            </select>
          </Field>
          {values.holidayLocation?.region === 'BY' ? (
            <>
              {triSelect('mariaeHimmelfahrt', translate('customer.holiday.mariaeHimmelfahrt'))}
              {triSelect('augsburgerFriedensfest', translate('customer.holiday.augsburgerFriedensfest'))}
            </>
          ) : null}
          {values.holidayLocation?.region === 'SN' || values.holidayLocation?.region === 'TH'
            ? triSelect('fronleichnam', translate('customer.holiday.fronleichnam'))
            : null}
          {values.holidayLocation?.region === 'AUSLAND' ? (
            <label className="edit-field edit-field--checkbox">
              <input
                type="checkbox"
                data-testid="kunden-edit-holiday-abroad-confirmed"
                checked={values.holidayLocation.auslandOhneFeiertag === true}
                onChange={(event) =>
                  setHoliday(
                    normalizeHolidayLocation({ region: 'AUSLAND', auslandOhneFeiertag: event.target.checked }) ?? null,
                  )
                }
              />
              <span>{translate('customer.holiday.abroadConfirmed')}</span>
            </label>
          ) : null}
        </fieldset>

        {error ? (
          <p className="form-error" data-testid="kunden-edit-error">
            {error}
          </p>
        ) : null}

        <div className="form-actions">
          <Button
            type="submit"
            disabled={busy}
            data-testid="kunden-edit-save"
          >
            {translate('common.save')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onCancel}
            data-testid="kunden-edit-cancel"
          >
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
