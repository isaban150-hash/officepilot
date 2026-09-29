/**
 * E-MAIL-07E — der E-Mail-Bereich auf /kommunikation: Reiter „Posteingang"
 * und „Gesendet" plus „Neue E-Mail". Der gewählte Reiter steht in der URL
 * (`?postfach=gesendet`) und überlebt so einen Reload.
 */
import type { ComponentProps } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { DetailSection } from '../ui/Section';
import { InboxEmailList } from './InboxEmailList';
import { SentEmailList } from './SentEmailList';

interface Props {
  /** Nur zum Testen: Lade-Funktionen der Listen ersetzen. */
  inbox?: ComponentProps<typeof InboxEmailList>;
  sent?: Omit<ComponentProps<typeof SentEmailList>, 'embedded'>;
}

export function EmailCenter({ inbox, sent }: Props) {
  const { translate } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('postfach') === 'gesendet' ? 'sent' : 'inbox';

  const select = (next: 'inbox' | 'sent') => {
    const params = new URLSearchParams(searchParams);
    if (next === 'sent') params.set('postfach', 'gesendet');
    else params.delete('postfach');
    setSearchParams(params, { replace: true });
  };

  return (
    <DetailSection
      title={t('freeEmail.section.title')}
      description={t('freeEmail.section.hint')}
      testId="kommunikation-email-section"
      action={
        <Link to="/kommunikation/email/neu" className="btn btn--primary btn--sm" data-testid="kommunikation-email-new">
          {t('freeEmail.action.new')}
        </Link>
      }
    >
      <div className="email-center-tabs" role="tablist" aria-label={t('freeEmail.section.title')}>
        {(['inbox', 'sent'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={`email-center-tab ${tab === item ? 'email-center-tab--active' : ''}`}
            data-testid={`kommunikation-email-tab-${item}`}
            onClick={() => select(item)}
          >
            {t(`inboundEmail.tab.${item}`)}
          </button>
        ))}
      </div>
      {tab === 'inbox' ? <InboxEmailList {...inbox} /> : <SentEmailList {...sent} embedded />}
    </DetailSection>
  );
}
