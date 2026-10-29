import type { MaterialStandard } from '../../types/models';
import type { CommunicationChannel } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP6; F-04) — Auswahllisten für Materialstandard und bevorzugten Kanal. Eine Quelle für den
 * Einrichtungsassistenten und die Firmendaten: beide zeigen dieselben Werte.
 */
export const MATERIAL_OPTIONS: { value: MaterialStandard; labelKey: TranslationKey }[] = [
  { value: 'auftraggeber', labelKey: 'material.auftraggeber' },
  { value: 'betrieb', labelKey: 'material.betrieb' },
  { value: 'gemischt', labelKey: 'material.gemischt' },
  { value: 'unclear', labelKey: 'material.unclear' },
];

/*
 * EINRICHTUNG-01 (AP3, O-04.2; EIN-34) — WhatsApp stand hier zur Wahl, ohne dass es dafür einen Versandweg gibt
 * (Master §12). Angeboten wird nur, was funktioniert.
 */
export const CHANNEL_OPTIONS: { value: CommunicationChannel; labelKey: TranslationKey }[] = [
  { value: 'email', labelKey: 'communication.channel.email' },
  { value: 'letter', labelKey: 'communication.channel.letter' },
];
