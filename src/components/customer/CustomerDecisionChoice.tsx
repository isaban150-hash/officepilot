/**
 * CUSTOMER-FACHOBJEKT-04B — explicit customer decision for a new Vorgang.
 *
 * Pure presentation: all state arrives via props, nothing is persisted here and
 * no customer/Vorgang service is called. No option is preselected and no
 * customer is ever matched automatically by name.
 */
import { useApp } from '../../context/AppContext';
import type { Customer } from '../../types/models';

export type CustomerDecisionMode = 'new' | 'existing' | 'none';

interface CustomerDecisionChoiceProps {
  mode: CustomerDecisionMode | null;
  onModeChange: (mode: CustomerDecisionMode) => void;
  customers: Customer[];
  selectedCustomerId: string | null;
  onSelectCustomer: (customerId: string) => void;
  /** Validation message shown below the choice; never a success statement. */
  hint?: string | null;
}

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
