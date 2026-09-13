/**
 * CUSTOMER-IDENTITY-DUPLICATE-01A — die bewusste Entscheidung vor einer
 * wahrscheinlich doppelten Kundenanlage.
 *
 * Reine Darstellung: Kandidaten kommen vom Service (`customer.duplicateCandidate`),
 * die Entscheidung geht als Callback an den jeweiligen Anlageweg zurück.
 * Sichere Hauptaktion: vorhandenen Kunden verwenden. Die Neuanlage ist eine
 * eigene, ausdrücklich beschriftete Aktion — nie der normale Weiter-/Speichern-
 * Klick, der die Warnung ausgelöst hat.
 */
import { useApp } from '../../context/AppContext';
import { Button } from '../ui/Button';
import { buildCustomerSubline } from './CustomerDecisionChoice';
import type { CustomerDuplicateCandidate } from '../../services/customer/customerDuplicateService';

interface CustomerDuplicateDecisionProps {
  candidates: CustomerDuplicateCandidate[];
  onUseExisting: (customerId: string) => void;
  onCreateAnyway: () => void;
  busy?: boolean;
}

function formatCreatedAt(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(language === 'de' ? 'de-DE' : language, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function CustomerDuplicateDecision({ candidates, onUseExisting, onCreateAnyway, busy = false }: CustomerDuplicateDecisionProps) {
  const { translate, language } = useApp();
  if (candidates.length === 0) return null;
  const onlyWeak = candidates.every((candidate) => candidate.strength === 'weak');

  return (
    <div
      className="invoice-hint invoice-hint--warning customer-duplicate"
      role="alert"
      data-testid="customer-duplicate-decision"
    >
      <p className="customer-duplicate__title">{translate('customerDuplicate.title')}</p>
      <p className="customer-duplicate__hint">
        {translate(onlyWeak ? 'customerDuplicate.weakHint' : 'customerDuplicate.hint')}
      </p>
      <ul className="customer-duplicate__list">
        {candidates.map((candidate) => {
          const created = formatCreatedAt(candidate.customer.createdAt, language);
          return (
            <li key={candidate.customer.id} className="customer-duplicate__item" data-testid={`customer-duplicate-candidate-${candidate.customer.id}`}>
              <div className="customer-duplicate__facts">
                <strong>{candidate.customer.name}</strong>
                <span>{buildCustomerSubline(candidate.customer, translate('customerDecision.noAddress'))}</span>
                {candidate.customer.contactPerson.trim() ? <span>{candidate.customer.contactPerson.trim()}</span> : null}
                {candidate.customer.email.trim() ? <span>{candidate.customer.email.trim()}</span> : null}
                {created ? <span>{translate('customerDecision.createdAt').replace('{date}', created)}</span> : null}
              </div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => onUseExisting(candidate.customer.id)}
                data-testid={`customer-duplicate-use-existing-${candidate.customer.id}`}
              >
                {translate('customerDuplicate.useExisting')}
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={onCreateAnyway}
        data-testid="customer-duplicate-create-anyway"
      >
        {translate('customerDuplicate.createAnyway')}
      </Button>
    </div>
  );
}
