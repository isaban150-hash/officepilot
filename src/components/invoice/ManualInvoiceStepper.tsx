import type { ManualInvoiceStep } from '../../services/invoice/manualInvoiceFlow';
import type { TranslationKey } from '../../i18n';

interface Props {
  current: ManualInvoiceStep;
  /** Bis zu welchem Schritt die Daten vollständig sind — nur dorthin darf gesprungen werden. */
  reachable: ManualInvoiceStep;
  onSelect: (step: ManualInvoiceStep) => void;
  translate: (key: TranslationKey) => string;
}

const STEPS: readonly ManualInvoiceStep[] = ['customer', 'positions', 'details', 'review'];

/**
 * MANUAL-INVOICE-UI-01B1B — klein und funktional: vier Punkte, der aktuelle
 * hervorgehoben, erreichte Schritte anklickbar. Fortschritt als „n/4".
 */
export function ManualInvoiceStepper({ current, reachable, onSelect, translate }: Props) {
  const currentIndex = STEPS.indexOf(current);
  const reachableIndex = STEPS.indexOf(reachable);

  return (
    <nav className="manual-invoice-stepper" aria-label={translate('manualInvoice.progress')}>
      <p className="manual-invoice-stepper__progress" data-testid="manual-invoice-progress">
        {currentIndex + 1}/{STEPS.length}
      </p>
      <ol className="manual-invoice-stepper__list">
        {STEPS.map((step, index) => {
          const state =
            index === currentIndex ? 'current' : index <= reachableIndex ? 'done' : 'upcoming';
          const clickable = index <= reachableIndex && index !== currentIndex;
          return (
            <li
              key={step}
              className={`manual-invoice-stepper__item manual-invoice-stepper__item--${state}`}
              aria-current={index === currentIndex ? 'step' : undefined}
            >
              <button
                type="button"
                className="manual-invoice-stepper__button"
                disabled={!clickable}
                onClick={() => onSelect(step)}
                data-testid={`manual-invoice-stepper-${step}`}
              >
                <span className="manual-invoice-stepper__index">{index + 1}</span>
                <span className="manual-invoice-stepper__label">
                  {translate(`manualInvoice.step.${step}` as TranslationKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
