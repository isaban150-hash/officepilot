import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';

export interface DropdownMenuItem {
  id: string;
  label: string;
  href?: string;
  onSelect?: () => void;
  destructive?: boolean;
  testId?: string;
}

export interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: 'start' | 'end';
  testId?: string;
  ariaLabel?: string;
}

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  testId = 'dropdown-menu',
  ariaLabel = 'Menü',
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, close]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className="dropdown-menu" ref={rootRef} data-testid={testId}>
      <button
        type="button"
        className="dropdown-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={ariaLabel}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={panelId}
          role="menu"
          className={`dropdown-menu__panel dropdown-menu__panel--align-${align}`}
          data-testid={`${testId}-panel`}
        >
          {items.map((item) => {
            const className = [
              'dropdown-menu__item',
              item.destructive ? 'dropdown-menu__item--danger' : '',
            ]
              .filter(Boolean)
              .join(' ');

            if (item.href) {
              return (
                <Link
                  key={item.id}
                  role="menuitem"
                  to={item.href}
                  className={className}
                  data-testid={item.testId}
                  onClick={close}
                >
                  {item.label}
                </Link>
              );
            }

            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className={className}
                data-testid={item.testId}
                onClick={() => {
                  item.onSelect?.();
                  close();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
