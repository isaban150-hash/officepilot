import { useId, type ReactNode } from 'react';

/**
 * UIUX-FOUNDATION-01B — Abschnitte statt Karten-in-Karten.
 *
 * `SectionHeader` ist die Überschriftzeile (Titel, optionale Beschreibung,
 * optionale Aktion rechts). `DetailSection` ist der Abschnitt einer
 * Detailseite: eine Überschriftzeile plus Inhalt, ohne eigenen weißen
 * Kasten — die Seite liefert die Fläche, der Abschnitt nur Gliederung.
 *
 * Die Klassen `ui-section-*` sind bewusst neu, weil `.section-header` in
 * layout.css bereits eine andere (Overline-)Optik trägt.
 */
export type SectionHeadingLevel = 2 | 3;

export interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  level?: SectionHeadingLevel;
  id?: string;
  className?: string;
  testId?: string;
}

export function SectionHeader({ title, description, action, level = 2, id, className = '', testId }: SectionHeaderProps) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div className={['ui-section-header', className].filter(Boolean).join(' ')} data-testid={testId}>
      <div className="ui-section-header__text">
        <Heading id={id} className="ui-section-header__title">
          {title}
        </Heading>
        {description ? <p className="ui-section-header__description">{description}</p> : null}
      </div>
      {action ? <div className="ui-section-header__action">{action}</div> : null}
    </div>
  );
}

export interface DetailSectionProps extends Omit<SectionHeaderProps, 'id' | 'className' | 'testId'> {
  children: ReactNode;
  /** Sanft abgesetzte Fläche für zusammengehörige Daten; Standard: keine. */
  surface?: boolean;
  className?: string;
  testId?: string;
}

export function DetailSection({
  title,
  description,
  action,
  level = 2,
  surface = false,
  className = '',
  testId,
  children,
}: DetailSectionProps) {
  const headingId = useId();
  return (
    <section
      className={['ui-section', surface ? 'ui-section--surface' : '', className].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
      data-testid={testId}
    >
      <SectionHeader title={title} description={description} action={action} level={level} id={headingId} />
      <div className="ui-section__body">{children}</div>
    </section>
  );
}
