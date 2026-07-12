const STORAGE_KEY = 'officepilot_home_hint_dismissals';

export type HomeHintDismissAction = 'done' | 'snooze' | 'hidden';
export type SnoozeDuration = 'tomorrow' | '3days' | 'nextweek';

interface HintDismissalRecord {
  action: HomeHintDismissAction;
  until?: string;
  at: string;
}

type DismissalStore = Record<string, HintDismissalRecord>;

function readStore(): DismissalStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DismissalStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: DismissalStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function buildHomeHintId(messageKey: string, params?: Record<string, string | number>): string {
  if (!params || Object.keys(params).length === 0) return messageKey;
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('|');
  return `${messageKey}::${sorted}`;
}

export function computeSnoozeUntil(duration: SnoozeDuration, now: Date = new Date()): string {
  const until = new Date(now);
  until.setHours(0, 0, 0, 0);
  if (duration === 'tomorrow') {
    until.setDate(until.getDate() + 1);
  } else if (duration === '3days') {
    until.setDate(until.getDate() + 3);
  } else {
    until.setDate(until.getDate() + 7);
  }
  return until.toISOString();
}

export function isHomeHintVisible(hintId: string, now: Date = new Date()): boolean {
  const record = readStore()[hintId];
  if (!record) return true;
  if (record.action === 'done' || record.action === 'hidden') return false;
  if (record.action === 'snooze' && record.until) {
    return now.toISOString() >= record.until;
  }
  return true;
}

export function dismissHomeHint(
  hintId: string,
  action: HomeHintDismissAction,
  now: Date = new Date(),
): void {
  const store = readStore();
  const record: HintDismissalRecord = { action, at: now.toISOString() };
  if (action === 'snooze') {
    record.until = computeSnoozeUntil('tomorrow', now);
  }
  store[hintId] = record;
  writeStore(store);
}

export function snoozeHomeHint(
  hintId: string,
  duration: SnoozeDuration,
  now: Date = new Date(),
): void {
  const store = readStore();
  store[hintId] = {
    action: 'snooze',
    until: computeSnoozeUntil(duration, now),
    at: now.toISOString(),
  };
  writeStore(store);
}

export function resetHomeHintDismissals(): void {
  localStorage.removeItem(STORAGE_KEY);
}
