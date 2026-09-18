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
      {/*
        CLOUD-DURABILITY-CORE-01E — der Wissensbestand bleibt vorerst auf diesem
        Gerät. Ein Nutzer, der hier etwas festhält, darf das nicht erst beim
        Gerätewechsel merken; ein zweiter Satz im vorhandenen Hinweis genügt —
        keine zusätzliche Karte, keine Warnung.
      */}
      <InlineNotice tone="neutral">
        {translate('knowledge.page.hint')} {translate('deviceOnly.knowledge')}
      </InlineNotice>
      <KnowledgePanel />
    </Page>
  );
}
