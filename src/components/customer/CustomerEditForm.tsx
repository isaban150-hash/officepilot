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
import type { Customer, CustomerBilling } from '../../types/models';

interface CustomerEditFormProps {
  customer: Customer;
  busy: boolean;
  error: string | null;
  onSave: (changes: CustomerBilling) => void;
  onCancel: () => void;
}

function valuesOf(customer: Customer): CustomerBilling {
  return {
    name: customer.name,
    contactPerson: customer.contactPerson,
    street: customer.street,
    zip: customer.zip,
    city: customer.city,
    email: customer.email,
    phone: customer.phone,
  };
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
  const [values, setValues] = useState<CustomerBilling>(() => valuesOf(customer));

  // Switching to another customer loads that customer's values; nothing is carried over.
  useEffect(() => {
    setValues(valuesOf(customer));
  }, [customer.id]);

  const set = (field: keyof CustomerBilling) => (value: string) =>
    setValues((prev) => ({ ...prev, [field]: value }));

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
