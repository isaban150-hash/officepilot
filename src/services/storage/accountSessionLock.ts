import { accountLockName } from './deviceDataService';

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.29, K6) — jeder Tab mit einer Sitzung dieses Kontos hält eine geteilte Sperre
 * (Web Locks). „Daten von diesem Gerät entfernen“ braucht die exklusive Sperre desselben Namens: Sie greift erst, wenn
 * alle anderen Tabs sich abgemeldet und ihre Sperre freigegeben haben. Ohne Web Locks (ältere Browser) gibt es keine
 * Sperre; das Entfernen wartet dann nur kurz (Grenze, dokumentiert).
 */
let gehalten: { userId: string; release: () => void } | null = null;

export function holdAccountSessionLock(userId: string): void {
  if (gehalten?.userId === userId) return;
  releaseAccountSessionLock();
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) return;
  let freigeben: () => void = () => undefined;
  const halten = new Promise<void>((resolve) => {
    freigeben = resolve;
  });
  void locks.request(accountLockName(userId), { mode: 'shared' }, () => halten).catch(() => undefined);
  gehalten = { userId, release: freigeben };
}

export function releaseAccountSessionLock(): void {
  const vorher = gehalten;
  gehalten = null;
  vorher?.release();
}

export function heldAccountSessionLock(): string | null {
  return gehalten?.userId ?? null;
}
