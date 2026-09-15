import type { ReactNode } from 'react';
import type { StatusTone } from '../../services/ui/statusTone';
import { Icon, type IconId } from './Icon';

/**
 * UIUX-FOUNDATION-01B — Badge ist die kanonische Statusdarstellung.
 *
 * Der Ton kommt aus `statusTone.ts` (neutral/info/success/warning/critical);
 * die älteren Werte `default` und `danger` bleiben als Aliase gültig, damit
 * bestehende Aufrufer unverändert weiterlaufen. Ein Badge trägt immer Text —
 * Farbe allein ist kein Status.
 */
export type BadgeTone = StatusTone | 'default' | 'danger';

const TONE_CLASS: Record<BadgeTone, string> = {
  default: 'badge--default',
  neutral: 'badge--default',
  info: 'badge--info',
  success: 'badge--success',
  warning: 'badge--warning',
  danger: 'badge--danger',
  critical: 'badge--danger',
};

/** Standard-Icons je Ton; bewusst zurückhaltend, optional. */
const TONE_ICON: Record<BadgeTone, IconId | null> = {
  default: null,
  neutral: null,
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'alert',
  critical: 'alert',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /** `true` = Standard-Icon des Tons, sonst eine konkrete Icon-Kennung. */
  icon?: boolean | IconId;
  className?: string;
  'data-testid'?: string;
  title?: string;
}

export function Badge({ children, tone = 'default', icon, className = '', title, 'data-testid': testId }: BadgeProps) {
  const iconId: IconId | null = icon === true ? TONE_ICON[tone] : icon || null;
  return (
    <span
      className={['badge', TONE_CLASS[tone], className].filter(Boolean).join(' ')}
      data-tone={tone === 'default' ? 'neutral' : tone === 'danger' ? 'critical' : tone}
      data-testid={testId}
      title={title}
    >
      {iconId ? <Icon id={iconId} size="sm" className="badge__icon" /> : null}
      <span className="badge__label">{children}</span>
    </span>
  );
}

export interface StatusBadgeProps {
  tone: StatusTone;
  /** Sichtbarer Statustext — Pflicht. */
  label: string;
  icon?: boolean | IconId;
  className?: string;
  'data-testid'?: string;
}

/** Fachstatus-Badge: Ton aus `statusTone`, Text immer sichtbar. */
export function StatusBadge({ tone, label, icon = true, className, 'data-testid': testId }: StatusBadgeProps) {
  return (
    <Badge tone={tone} icon={icon} className={['status-badge', className].filter(Boolean).join(' ')} data-testid={testId}>
      {label}
    </Badge>
  );
}
