import { formatDisplayDate, formatEuroAmount, toDateTimeAttribute } from '../../utils/displayFormat';

/**
 * UIUX-FOUNDATION-01B — Anzeigeprimitive für Beträge und Daten.
 *
 * Tabellarische Ziffern und rechtsbündige Ausrichtung kommen aus dem CSS
 * (`.money-display`), damit Beträge in Listen untereinander vergleichbar
 * bleiben. Negative Beträge werden nur markiert, nicht umgefärbt — Farbe
 * bleibt dem Statussystem vorbehalten.
 */
export interface MoneyDisplayProps {
  value: number | null | undefined;
  /** Hervorhebung für Summen. */
  emphasis?: boolean;
  className?: string;
  testId?: string;
}

export function MoneyDisplay({ value, emphasis = false, className = '', testId }: MoneyDisplayProps) {
  const negative = typeof value === 'number' && value < 0;
  return (
    <span
      className={['money-display', emphasis ? 'money-display--emphasis' : '', negative ? 'money-display--negative' : '', className]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      {formatEuroAmount(value)}
    </span>
  );
}

export interface DateDisplayProps {
  value: string | Date | null | undefined;
  className?: string;
  testId?: string;
}

export function DateDisplay({ value, className = '', testId }: DateDisplayProps) {
  const dateTime = toDateTimeAttribute(value);
  const text = formatDisplayDate(value);
  if (!dateTime) {
    return (
      <span className={['date-display', className].filter(Boolean).join(' ')} data-testid={testId}>
        {text}
      </span>
    );
  }
  return (
    <time className={['date-display', className].filter(Boolean).join(' ')} dateTime={dateTime} data-testid={testId}>
      {text}
    </time>
  );
}
