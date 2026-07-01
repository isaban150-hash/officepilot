import { PageHeader } from '../components/ui/Card';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { useApp } from '../context/AppContext';

export function WissenPage() {
  const { translate } = useApp();

  return (
    <div className="page" data-testid="wissen-page">
      <PageHeader title={translate('knowledge.page.title')} subtitle={translate('knowledge.page.subtitle')} />
      <p className="hint-text">{translate('knowledge.page.hint')}</p>
      <KnowledgePanel />
    </div>
  );
}
