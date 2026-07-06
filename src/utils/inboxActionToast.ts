import type { TranslationKey } from '../i18n';
import type { InboxActionResult } from '../services/inboxService';

type TranslateFn = (key: TranslationKey) => string;

export function formatInboxActionToast(result: InboxActionResult, translate: TranslateFn): string {
  if (result.messageKey) {
    let msg = translate(result.messageKey);
    if (result.messageParams) {
      for (const [key, value] of Object.entries(result.messageParams)) {
        msg = msg.replace(`{${key}}`, value);
      }
    }
    if (result.taskCreated) {
      msg += ` ${translate('inbox.toast.taskCreatedSuffix').replace('{title}', result.taskCreated.title)}`;
    }
    return msg;
  }

  if (result.taskCreated) {
    return `${result.message} ${translate('inbox.toast.taskCreatedSuffix').replace('{title}', result.taskCreated.title)}`;
  }

  return result.message;
}
