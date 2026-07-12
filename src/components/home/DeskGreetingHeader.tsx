import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { buildDeskGreeting } from '../../services/deskIntelligenceService';

export function DeskGreetingHeader() {
  const { translate, companyProfile } = useApp();

  const greeting = useMemo(() => {
    const contactFirstName = companyProfile.contactPerson?.trim().split(/\s+/)[0];
    return buildDeskGreeting(contactFirstName);
  }, [companyProfile.contactPerson]);

  const greetingText = greeting.firstName
    ? `${translate(greeting.messageKey)}, ${greeting.firstName}`
    : translate(greeting.messageKey);

  return (
    <header className="desk-greeting" data-testid="desk-greeting-header">
      <h1 className="desk-greeting__title">{greetingText}</h1>
      <p className="desk-greeting__subtitle">{translate('desk.prioritiesTitle')}</p>
    </header>
  );
}
