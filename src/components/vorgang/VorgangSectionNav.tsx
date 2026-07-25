import type { TranslationKey } from '../../i18n';

export type VorgangDetailSection = 'overview' | 'order' | 'amendments' | 'invoices';

const SECTIONS: VorgangDetailSection[] = ['overview', 'order', 'amendments', 'invoices'];

const SECTION_LABEL_KEYS: Record<VorgangDetailSection, TranslationKey> = {
  overview: 'vorgang.section.overview',
  order: 'vorgang.section.order',
  amendments: 'vorgang.section.amendments',
  invoices: 'vorgang.section.invoices',
};

interface VorgangSectionNavProps {
  activeSection: VorgangDetailSection;
  onChange: (section: VorgangDetailSection) => void;
  translate: (key: TranslationKey) => string;
}

export function VorgangSectionNav({
  activeSection,
  onChange,
  translate,
}: VorgangSectionNavProps) {
  return (
    <div
      className="vorgang-section-nav"
      role="tablist"
      aria-label={translate('vorgang.section.navLabel')}
      data-testid="vorgang-section-nav"
    >
      {SECTIONS.map((section) => {
        const selected = activeSection === section;
        return (
          <button
            key={section}
            type="button"
            role="tab"
            id={`vorgang-tab-${section}`}
            aria-selected={selected}
            aria-controls={`vorgang-panel-${section}`}
            tabIndex={selected ? 0 : -1}
            className={
              selected
                ? 'vorgang-section-nav__tab vorgang-section-nav__tab--active'
                : 'vorgang-section-nav__tab'
            }
            data-testid={`vorgang-section-tab-${section}`}
            onClick={() => onChange(section)}
            onKeyDown={(event) => {
              let next: VorgangDetailSection | undefined;
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const index = SECTIONS.indexOf(section);
                const delta = event.key === 'ArrowRight' ? 1 : -1;
                next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]!;
              } else if (event.key === 'Home') {
                event.preventDefault();
                next = SECTIONS[0]!;
              } else if (event.key === 'End') {
                event.preventDefault();
                next = SECTIONS[SECTIONS.length - 1]!;
              } else {
                return;
              }
              onChange(next);
              // Focus after React applies aria-selected/tabIndex in the same event turn.
              queueMicrotask(() => {
                document.getElementById(`vorgang-tab-${next}`)?.focus();
              });
            }}
          >
            {translate(SECTION_LABEL_KEYS[section])}
          </button>
        );
      })}
    </div>
  );
}

export function vorgangSectionPanelProps(
  section: VorgangDetailSection,
  activeSection: VorgangDetailSection,
) {
  const selected = activeSection === section;
  return {
    role: 'tabpanel' as const,
    id: `vorgang-panel-${section}`,
    'aria-labelledby': `vorgang-tab-${section}`,
    hidden: !selected,
    tabIndex: 0 as const,
    'data-testid': `vorgang-section-panel-${section}`,
  };
}
