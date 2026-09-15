/**
 * UIUX-FOUNDATION-01B — Navy-Trust-Primitives.
 *
 *  A  statusTone: sichere Fachstatus-Zuordnungen, unbekannt → neutral
 *  B  Badge/StatusBadge: Ton-Klassen, Aliase, Text immer sichtbar, Icon optional
 *  C  Icon: dekorativ vs. beschriftet, Registry vollständig
 *  D  Dialog: aria, Fokus beim Öffnen, Tab-Falle, Escape, busy sperrt, Fokus-Rückgabe, Backdrop
 *  E  SimpleConfirmDialog auf Dialog-Basis: Testids/Fokus/Fehler unverändert
 *  F  FormField/Input/Select/Textarea: label↔control, describedby, invalid, required, disabled, readonly
 *  G  PrimaryActionBar: Slots, sticky-Klasse, DOM-Reihenfolge Sekundär vor Primär
 *  H  SectionHeader/DetailSection: Überschriftebene, aria-labelledby, kein Card-Wrapper
 *  I  ReadOnlyNotice: role=status, Text
 *  J  MoneyDisplay/DateDisplay + displayFormat
 *  K  Referenzfall DocumentAddActions ohne Emoji
 */
import { act, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge, StatusBadge } from './Badge';
import { Badge as BadgeFromCard } from './Card';
import { Dialog } from './Dialog';
import { SimpleConfirmDialog } from './SimpleConfirmDialog';
import { FormField } from './FormField';
import { Input } from './Input';
import { Select } from './Select';
import { Textarea } from './Textarea';
import { Icon, ICON_IDS } from './Icon';
import { PrimaryActionBar } from './PrimaryActionBar';
import { DetailSection, SectionHeader } from './Section';
import { ReadOnlyNotice } from './ReadOnlyNotice';
import { DateDisplay, MoneyDisplay } from './Display';
import { Button } from './Button';
import { DocumentAddActions } from '../documents/DocumentAddActions';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { formatDisplayDate, formatEuroAmount } from '../../utils/displayFormat';
import {
  inboxStatusTone,
  paymentStatusTone,
  reviewStateTone,
  taskStatusTone,
  vorgangStatusTone,
  isStatusTone,
} from '../../services/ui/statusTone';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

async function flushFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      queueMicrotask(() => window.requestAnimationFrame(() => resolve()));
    });
  });
}

function key(target: EventTarget, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('UIUX-FOUNDATION-01B — statusTone (A)', () => {
  it('ordnet Zahlungsstatus sicher zu; storniert bleibt ruhig', () => {
    expect(paymentStatusTone('offen')).toBe('neutral');
    expect(paymentStatusTone('teilbezahlt')).toBe('warning');
    expect(paymentStatusTone('bezahlt')).toBe('success');
    expect(paymentStatusTone('ueberfaellig')).toBe('critical');
    expect(paymentStatusTone('storniert')).toBe('neutral');
  });

  it('Task/Inbox/Vorgang/Review-Zustände und unbekannte Werte', () => {
    expect(taskStatusTone('done')).toBe('success');
    expect(inboxStatusTone('spaeter_klaeren')).toBe('warning');
    expect(inboxStatusTone('neu')).toBe('info');
    expect(vorgangStatusTone('wartet')).toBe('warning');
    expect(vorgangStatusTone('abgeschlossen')).toBe('success');
    expect(reviewStateTone('needs_review')).toBe('warning');
    expect(reviewStateTone('conflict')).toBe('critical');
    expect(paymentStatusTone('unbekannt' as never)).toBe('neutral');
    expect(isStatusTone('critical')).toBe(true);
    expect(isStatusTone('danger')).toBe(false);
  });
});

describe('UIUX-FOUNDATION-01B — Badge (B)', () => {
  it('rendert alle Töne mit sichtbarem Text und Ton-Attribut', () => {
    const html = renderToStaticMarkup(
      <>
        <Badge tone="neutral">Offen</Badge>
        <Badge tone="critical">Überfällig</Badge>
        <Badge tone="danger">Alt-Danger</Badge>
        <Badge>Standard</Badge>
        <StatusBadge tone="success" label="Bezahlt" data-testid="paid" />
      </>,
    );
    expect(html).toContain('badge--default');
    expect(html).toContain('badge--danger');
    expect(html).toContain('data-tone="critical"');
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain('Überfällig');
    expect(html).toContain('status-badge');
    expect(html).toContain('data-icon="check"');
    expect(html).toContain('<span class="badge__label">Bezahlt</span>');
  });

  it('Badge aus Card.tsx ist dieselbe Komponente (kein zweites Badge)', () => {
    expect(BadgeFromCard).toBe(Badge);
  });

  it('Status ist nie nur Farbe: Text bleibt, Icon ist optional', () => {
    const withoutIcon = renderToStaticMarkup(<StatusBadge tone="warning" label="Teilbezahlt" icon={false} />);
    expect(withoutIcon).not.toContain('ui-icon');
    expect(withoutIcon).toContain('Teilbezahlt');
  });
});

describe('UIUX-FOUNDATION-01B — Icon (C)', () => {
  it('ist dekorativ ohne label und beschriftet mit label', () => {
    expect(renderToStaticMarkup(<Icon id="check" />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(<Icon id="lock" label="Gesperrt" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Gesperrt"');
    expect(labelled).not.toContain('aria-hidden');
  });

  it('jede Registry-Kennung rendert einen Pfad', () => {
    for (const id of ICON_IDS) {
      const html = renderToStaticMarkup(<Icon id={id} />);
      expect(html, id).toMatch(/<(path|circle|rect)/);
    }
    expect(ICON_IDS.length).toBeGreaterThanOrEqual(30);
  });
});

function DialogHarness({ busy = false, onClose = () => {} }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Öffnen
      </button>
      <Dialog
        open={open}
        title="Titel"
        description="Beschreibung"
        busy={busy}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        testId="t-dialog"
        actions={
          <>
            <Button variant="outline" data-testid="d-cancel" onClick={() => setOpen(false)}>
              Abbrechen
            </Button>
            <Button data-testid="d-ok">OK</Button>
          </>
        }
      >
        <input data-testid="d-input" />
      </Dialog>
    </>
  );
}

describe('UIUX-FOUNDATION-01B — Dialog (D)', () => {
  it('aria, Fokus beim Öffnen auf erstes Element, Tab-Falle, Escape, Fokus-Rückgabe', async () => {
    const onClose = vi.fn();
    const c = mount(<DialogHarness onClose={onClose} />);
    const opener = c.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    act(() => {
      opener.focus();
      opener.click();
    });
    await flushFrame();
    const dialog = c.querySelector('[data-testid="t-dialog"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Titel');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe('Beschreibung');
    expect(dialog.querySelector('h2')).not.toBeNull();

    const input = c.querySelector<HTMLInputElement>('[data-testid="d-input"]')!;
    const ok = c.querySelector<HTMLButtonElement>('[data-testid="d-ok"]')!;
    expect(document.activeElement).toBe(input);

    /* Tab vom letzten Element springt zum ersten, Shift+Tab vom ersten zum letzten. */
    act(() => ok.focus());
    key(ok, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    key(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ok);

    key(window, { key: 'Escape' });
    await flushFrame();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(c.querySelector('[data-testid="t-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('busy sperrt Escape und Backdrop', async () => {
    const onClose = vi.fn();
    const c = mount(<DialogHarness busy onClose={onClose} />);
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="opener"]')!.click());
    await flushFrame();
    key(window, { key: 'Escape' });
    act(() => c.querySelector<HTMLElement>('[data-testid="t-dialog-backdrop"]')!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(c.querySelector('[data-testid="t-dialog"]')?.getAttribute('aria-busy')).toBe('true');
  });

  it('Backdrop-Klick schließt, Klick im Dialog nicht', async () => {
    const onClose = vi.fn();
    const c = mount(<DialogHarness onClose={onClose} />);
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="opener"]')!.click());
    await flushFrame();
    act(() => c.querySelector<HTMLElement>('[data-testid="t-dialog"]')!.click());
    expect(onClose).not.toHaveBeenCalled();
    act(() => c.querySelector<HTMLElement>('[data-testid="t-dialog-backdrop"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function ConfirmHarness({ onConfirm }: { onConfirm: () => boolean | Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const triggerRef = createRef<HTMLButtonElement>();
  return (
    <>
      <button ref={triggerRef} type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Löschen
      </button>
      <SimpleConfirmDialog
        open={open}
        title="Wirklich löschen?"
        message="Das kann nicht rückgängig gemacht werden."
        confirmLabel="Löschen"
        cancelLabel="Abbrechen"
        failureMessage="Löschen fehlgeschlagen."
        returnFocusRef={triggerRef}
        onConfirm={async () => {
          const ok = await onConfirm();
          if (ok) setOpen(false);
          return ok;
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

describe('UIUX-FOUNDATION-01B — SimpleConfirmDialog auf Dialog-Basis (E)', () => {
  it('Fokus auf Abbrechen, Escape schließt mit Fokus-Rückgabe, Testids unverändert', async () => {
    const onConfirm = vi.fn(() => true);
    const c = mount(<ConfirmHarness onConfirm={onConfirm} />);
    const trigger = c.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    act(() => {
      trigger.focus();
      trigger.click();
    });
    await flushFrame();
    expect(c.querySelector('[data-testid="simple-confirm-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(c.querySelector('[data-testid="simple-confirm-cancel"]'));
    expect(c.querySelector('.dialog--critical')).not.toBeNull();
    key(window, { key: 'Escape' });
    await flushFrame();
    expect(c.querySelector('[data-testid="simple-confirm-dialog"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('fehlgeschlagene Bestätigung zeigt Fehler, Dialog bleibt offen, Fokus auf Bestätigen', async () => {
    const onConfirm = vi.fn(() => false);
    const c = mount(<ConfirmHarness onConfirm={onConfirm} />);
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!.click());
    await flushFrame();
    await act(async () => {
      c.querySelector<HTMLButtonElement>('[data-testid="simple-confirm-confirm"]')!.click();
    });
    await flushFrame();
    expect(c.querySelector('[data-testid="simple-confirm-error"]')?.textContent).toBe('Löschen fehlgeschlagen.');
    expect(c.querySelector('[data-testid="simple-confirm-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(c.querySelector('[data-testid="simple-confirm-confirm"]'));
  });
});

describe('UIUX-FOUNDATION-01B — FormField & Controls (F)', () => {
  it('FormField verdrahtet label, hint, error, required, disabled, readonly', () => {
    const c = mount(
      <FormField label="Name" hint="Hinweis" required id="f-name">
        {(control) => <input data-testid="ctl" {...control} />}
      </FormField>,
    );
    const label = c.querySelector('label')!;
    const ctl = c.querySelector<HTMLInputElement>('[data-testid="ctl"]')!;
    expect(label.getAttribute('for')).toBe('f-name');
    expect(ctl.id).toBe('f-name');
    expect(ctl.getAttribute('aria-describedby')).toBe('f-name-hint');
    expect(document.getElementById('f-name-hint')?.textContent).toBe('Hinweis');
    expect(ctl.getAttribute('aria-required')).toBe('true');
    expect(ctl.required).toBe(true);
    expect(c.querySelector('.form-field__required')).not.toBeNull();
  });

  it('Fehler ersetzt Hinweis und markiert aria-invalid; disabled/readonly werden weitergereicht', () => {
    const c = mount(
      <>
        <FormField label="E-Mail" hint="Hinweis" error="Ungültig" id="f-mail">
          {(control) => <input data-testid="mail" {...control} />}
        </FormField>
        <FormField label="Gesperrt" disabled readOnly id="f-ro">
          {(control) => <input data-testid="ro" {...control} />}
        </FormField>
      </>,
    );
    const mail = c.querySelector<HTMLInputElement>('[data-testid="mail"]')!;
    expect(mail.getAttribute('aria-invalid')).toBe('true');
    expect(mail.getAttribute('aria-describedby')).toBe('f-mail-error');
    expect(document.getElementById('f-mail-hint')).toBeNull();
    expect(document.getElementById('f-mail-error')?.getAttribute('role')).toBe('alert');
    const ro = c.querySelector<HTMLInputElement>('[data-testid="ro"]')!;
    expect(ro.disabled).toBe(true);
    expect(ro.readOnly).toBe(true);
    expect(c.querySelector('.form-field--readonly.form-field--disabled')).not.toBeNull();
  });

  it('Input, Select und Textarea nutzen dasselbe FormField-Pattern; ohne id stabile generierte ids', () => {
    const c = mount(
      <>
        <Input label="Firma" helperText="Wie im Impressum" data-testid="in" />
        <Select label="Land" error="Pflichtfeld" data-testid="sel">
          <option value="de">Deutschland</option>
        </Select>
        <Textarea label="Notiz" readOnly value="fix" onChange={() => {}} data-testid="ta" />
      </>,
    );
    const inp = c.querySelector<HTMLInputElement>('[data-testid="in"]')!;
    const sel = c.querySelector<HTMLSelectElement>('[data-testid="sel"]')!;
    const ta = c.querySelector<HTMLTextAreaElement>('[data-testid="ta"]')!;
    for (const el of [inp, sel, ta]) {
      expect(el.id).toBeTruthy();
      expect(c.querySelector(`label[for="${el.id}"]`), el.id).not.toBeNull();
    }
    expect(document.getElementById(inp.getAttribute('aria-describedby')!)?.textContent).toBe('Wie im Impressum');
    expect(sel.getAttribute('aria-invalid')).toBe('true');
    expect(sel.closest('.select-wrap')).not.toBeNull();
    expect(ta.readOnly).toBe(true);
    expect(ta.classList.contains('textarea')).toBe(true);
    expect(ta.getAttribute('rows')).toBe('4');
  });
});

describe('UIUX-FOUNDATION-01B — PrimaryActionBar (G)', () => {
  it('genau ein Primary-Slot, Sekundär vor Primär im DOM, sticky-Klasse steuerbar', () => {
    const html = renderToStaticMarkup(
      <PrimaryActionBar
        note="Erst Freigeben vergibt die Nummer."
        secondary={<Button variant="outline">Bearbeiten</Button>}
        primary={<Button>Rechnung freigeben</Button>}
        ariaLabel="Aktionen"
      />,
    );
    expect(html).toContain('primary-action-bar--sticky');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Aktionen"');
    expect(html.indexOf('primary-action-bar__note')).toBeLessThan(html.indexOf('primary-action-bar__secondary'));
    expect(html.indexOf('primary-action-bar__secondary')).toBeLessThan(html.indexOf('primary-action-bar__primary'));
    expect(html.match(/primary-action-bar__primary/g)?.length).toBe(1);
    expect(renderToStaticMarkup(<PrimaryActionBar sticky={false} primary={<Button>OK</Button>} />)).not.toContain('--sticky');
  });
});

describe('UIUX-FOUNDATION-01B — Section (H)', () => {
  it('DetailSection ist ein section mit aria-labelledby und ohne Card-Klasse', () => {
    const c = mount(
      <DetailSection title="Zahlungen" description="Alle Eingänge" action={<Button variant="ghost">Erfassen</Button>} testId="sec">
        <p>Inhalt</p>
      </DetailSection>,
    );
    const section = c.querySelector('section[data-testid="sec"]')!;
    const heading = document.getElementById(section.getAttribute('aria-labelledby')!)!;
    expect(heading.tagName).toBe('H2');
    expect(heading.textContent).toBe('Zahlungen');
    expect(section.querySelector('.card')).toBeNull();
    expect(section.querySelector('.ui-section-header__action')).not.toBeNull();
    expect(renderToStaticMarkup(<SectionHeader title="Unter" level={3} />)).toContain('<h3');
  });
});

describe('UIUX-FOUNDATION-01B — ReadOnlyNotice (I)', () => {
  it('rendert role=status mit Schloss-Icon und Text', () => {
    const html = renderToStaticMarkup(<ReadOnlyNotice title="Nur Ansicht" message="Nur Inhaber können ändern." />);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-icon="lock"');
    expect(html).toContain('Nur Inhaber können ändern.');
  });
});

describe('UIUX-FOUNDATION-01B — Money/Date (J)', () => {
  it('formatiert wie die bestehenden Seitenhelfer (de-DE, „—“ bei leer)', () => {
    expect(formatEuroAmount(1234.5)).toBe('1.234,50 €');
    expect(formatEuroAmount(null)).toBe('—');
    expect(formatDisplayDate('2026-03-05')).toBe(new Date('2026-03-05').toLocaleDateString('de-DE'));
    expect(formatDisplayDate(null)).toBe('—');
    expect(formatDisplayDate('kein-datum')).toBe('kein-datum');
  });

  it('MoneyDisplay/DateDisplay: tabellarische Klassen, <time> nur bei gültigem Datum', () => {
    const html = renderToStaticMarkup(
      <>
        <MoneyDisplay value={-10} emphasis testId="m" />
        <DateDisplay value="2026-03-05" testId="d" />
        <DateDisplay value={null} testId="e" />
      </>,
    );
    expect(html).toContain('money-display--emphasis');
    expect(html).toContain('money-display--negative');
    expect(html).toMatch(/<time class="date-display" date[tT]ime="2026-03-05"/);
    expect(html).toContain('<span class="date-display" data-testid="e">—</span>');
  });
});

describe('UIUX-FOUNDATION-01B — Referenzfall Icon statt Emoji (K)', () => {
  it('DocumentAddActions rendert SVG-Icons und keine Emojis', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DocumentAddActions />
          <DocumentAddActions variant="inline" />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-icon="camera"');
    expect(html).toContain('data-icon="scanner"');
    expect(html).toContain('document-add-actions__inline-icon');
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
