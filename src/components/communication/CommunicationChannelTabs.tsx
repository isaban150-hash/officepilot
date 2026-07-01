import type { CommunicationChannel } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

interface CommunicationChannelTabsProps {
  channel: CommunicationChannel;
  onChange: (channel: CommunicationChannel) => void;
  translate: (key: TranslationKey) => string;
}

const CHANNELS: CommunicationChannel[] = ['email', 'whatsapp', 'letter'];

export function CommunicationChannelTabs({
  channel,
  onChange,
  translate,
}: CommunicationChannelTabsProps) {
  return (
    <div className="communication-channel-tabs" role="tablist" aria-label={translate('communication.channel.label')}>
      {CHANNELS.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={channel === item}
          className={`communication-channel-tab ${channel === item ? 'communication-channel-tab--active' : ''}`}
          data-testid={`communication-channel-${item}`}
          onClick={() => onChange(item)}
        >
          {translate(`communication.channel.${item}` as TranslationKey)}
        </button>
      ))}
    </div>
  );
}
