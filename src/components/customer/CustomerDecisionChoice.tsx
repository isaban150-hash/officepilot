/**
 * CUSTOMER-FACHOBJEKT-04B — explicit customer decision for a new Vorgang.
 *
 * Pure presentation: all state arrives via props, nothing is persisted here and
 * no customer/Vorgang service is called. No option is preselected and no
 * customer is ever matched automatically by name.
 */
import { useApp } from '../../context/AppContext';
import type { CustomerExtraFields } from './customerDecisionUi';
import type { Customer } from '../../types/models';
import type { TranslationKey } from '../../i18n';

export type CustomerDecisionMode = 'new' | 'existing' | 'none';

interface CustomerDecisionChoiceProps {
  mode: CustomerDecisionMode | null;
  onModeChange: (mode: CustomerDecisionMode) => void;
  customers: Customer[];
  selectedCustomerId: string | null;
  onSelectCustomer: (customerId: string) => void;
  /** Validation message shown below the choice; never a success statement. */
  hint?: string | null;
  /**
   * CUSTOMER-FACHOBJEKT-05C — optional master data of a new customer.
   * Controlled by the parent; the name field stays where it already is.
   */
  extraFields?: CustomerExtraFields;
  onExtraFieldChange?: (field: keyof CustomerExtraFields, value: string) => void;
}

const EXTRA_FIELD_LABELS: Array<{ field: keyof CustomerExtraFields; labelKey: TranslationKey }> = [
  { field: 'contactPerson', labelKey: 'kunden.detail.contactPerson' },
  { field: 'street', labelKey: 'companyProfile.street' },
  { field: 'zip', labelKey: 'companyProfile.zip' },
  { field: 'city', labelKey: 'companyProfile.city' },
  { field: 'email', labelKey: 'companyProfile.email' },
  { field: 'phone', labelKey: 'companyProfile.phone' },
];

/** Street / zip / city, or the creation date when no address is stored at all. */
export function buildCustomerSubline(
  customer: Customer,
  fallbackLabel: string,
): string {
  const street = customer.street.trim();
  const place = [customer.zip.trim(), customer.city.trim()].filter(Boolean).join(' ');
  const address = [street, place].filter(Boolean).join(', ');
  if (address) return address;
  const created = customer.createdAt.slice(0, 10);
  return created ? `${fallbackLabel} · ${created}` : fallbackLabel;
}

export function CustomerDecisionChoice({
  mode,
  onModeChange,
  customers,
  selectedCustomerId,
  onSelectCustomer,
  hint,
  extraFields,
  onExtraFieldChange,
}: CustomerDecisionChoiceProps) {
  const { translate } = useApp();
  const hasCustomers = customers.length > 0;

  const options: Array<{ value: CustomerDecisionMode; label: string; disabled?: boolean }> = [
    { value: 'new', label: translate('customerDecision.new') },
    {
      value: 'existing',
      label: translate('customerDecision.existing'),
      disabled: !hasCustomers,
    },
    { value: 'none', label: translate('customerDecision.none') },
  ];

  return (
    <div className="vorgang-dialog__customer" data-testid="customer-decision-choice">
      <h4 className="vorgang-dialog__similar-title">{translate('customerDecision.question')}</h4>

      <div className="similar-list">
        {options.map((option) => (
          <label
            key={option.value}
            className="similar-item"
            data-testid={`customer-decision-${option.value}`}
          >
            <input
              type="radio"
              name="customerDecisionMode"
              value={option.value}
              checked={mode === option.value}
              disabled={option.disabled}
              onChange={() => onModeChange(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              {option.value === 'existing' && !hasCustomers && (
                <>
                  <br />
                  {translate('customerDecision.noCustomers')}
                </>
              )}
              {option.value === 'none' && (
                <>
                  <br />
                  {translate('customerDecision.noneExplanation')}
                </>
              )}
            </span>
          </label>
        ))}
      </div>

      {mode === 'new' && extraFields && onExtraFieldChange && (
        <div className="vorgang-dialog__edit" data-testid="customer-decision-extra-fields">
          <p className="vorgang-dialog__review-hint" data-testid="customer-decision-optional-hint">
            {translate('customerDecision.optionalHint')}
          </p>
          {EXTRA_FIELD_LABELS.map(({ field, labelKey }) => (
            <label className="edit-field" key={field}>
              <span className="edit-field__label">{translate(labelKey)}</span>
              <input
                type="text"
                className="input"
                data-testid={`customer-decision-${field}`}
                value={extraFields[field]}
                onChange={(event) => onExtraFieldChange(field, event.target.value)}
              />
            </label>
          ))}
        </div>
      )}

      {mode === 'existing' && hasCustomers && (
        <div className="similar-list customer-decision__list" data-testid="customer-decision-list">
          {customers.map((customer) => (
            <label
              key={customer.id}
              className="similar-item"
              data-testid={`customer-option-${customer.id}`}
            >
              <input
                type="radio"
                name="customerDecisionCustomer"
                value={customer.id}
                checked={selectedCustomerId === customer.id}
                onChange={() => onSelectCustomer(customer.id)}
              />
              <span>
                <strong>{customer.name}</strong>
                <br />
                {buildCustomerSubline(customer, translate('customerDecision.noAddress'))}
              </span>
            </label>
          ))}
        </div>
      )}

      {hint && (
        <p className="vorgang-dialog__review-hint" data-testid="customer-decision-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
