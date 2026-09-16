import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { InlineNotice } from '../components/ui/States';
import { KnowledgePanel } from '../components/knowledge/KnowledgePanel';
import { useApp } from '../context/AppContext';

export function WissenPage() {
  const { translate } = useApp();

  return (
    <Page testId="wissen-page">
      <PageHeader title={translate('knowledge.page.title')} subtitle={translate('knowledge.page.subtitle')} />
      <InlineNotice tone="neutral">{translate('knowledge.page.hint')}</InlineNotice>
      <KnowledgePanel />
    </Page>
  );
}
