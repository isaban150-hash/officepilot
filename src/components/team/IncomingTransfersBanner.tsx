import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import {
  acceptOwnershipTransfer,
  declineOwnershipTransfer,
  listMyTransfers,
  type MyTransfer,
} from '../../services/team/teamService';
import { rebindWorkspace } from '../../services/workspace/workspaceMembershipChangeService';
import { failureMessage, t, type TranslationKey } from '../../i18n';
import type { AppLanguage } from '../../types/models';

/**
 * EINRICHTUNG-01 (AP4; Verträge 1.6, 1.6a) — ein offener Übergabeantrag an das eigene Konto: Übernehmen oder Ablehnen.
 * Nur das Zielkonto stimmt zu; die Plattform nimmt nie stellvertretend an. Nach der Übernahme bindet die App neu.
 */
export function IncomingTransfersBanner({ userId, language }: { userId: string | null; language: AppLanguage }) {
  const [items, setItems] = useState<MyTransfer[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; key: TranslationKey; params?: Record<string, string> } | null>(null);

  const load = useCallback(async () => {
    const result = await listMyTransfers();
    setItems(result.ok ? result.value : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load, userId]);

  if (items.length === 0 && !message) return null;

  const accept = async (item: MyTransfer) => {
    if (busy) return;
    setBusy(true);
    const result = await acceptOwnershipTransfer(item.transferId);
    setBusy(false);
    if (!result.ok) {
      setMessage({ ok: false, ...failureMessage(result) });
      await load();
      return;
    }
    rebindWorkspace({ userId, notice: { kind: 'owner', workspaceName: item.workspaceName } });
  };

  const decline = async (item: MyTransfer) => {
    if (busy) return;
    setBusy(true);
    const result = await declineOwnershipTransfer(item.transferId);
    setBusy(false);
    setMessage(result.ok ? { ok: true, key: 'transferIn.declined' } : { ok: false, ...failureMessage(result) });
    await load();
  };

  return (
    <div className="workspace-read-only-banner incoming-transfers" role="region" data-testid="incoming-transfers">
      {message ? (
        <p className={message.ok ? 'auth-form__success' : 'auth-form__error'} role={message.ok ? 'status' : 'alert'} data-testid="incoming-transfers-message">
          {t(message.key, language, message.params)}
        </p>
      ) : null}
      {items.map((item) => (
        <div key={item.transferId} data-testid={`incoming-transfer-${item.transferId}`}>
          <p>
            {item.kind === 'platform_repair'
              ? t('transferIn.repair', language, { workspace: item.workspaceName })
              : t('transferIn.body', language, { from: item.fromName ?? '—', workspace: item.workspaceName })}
          </p>
          <div className="form-actions">
            <Button type="button" size="sm" disabled={busy} onClick={() => void accept(item)} data-testid={`incoming-transfer-accept-${item.transferId}`}>
              {t('transferIn.accept', language)}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decline(item)} data-testid={`incoming-transfer-decline-${item.transferId}`}>
              {t('transferIn.decline', language)}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
