import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readdirSync, readFileSync } from 'node:fs';
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { checkSource } from '../src/design-check';
import type { CalendarMatch } from '../src/calendar';

// React DOM decides at import whether it runs in a browser, so the DOM comes first.
if (typeof document === 'undefined') GlobalRegistrator.register({ url: 'https://baby.example.com/' });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
const { createRoot } = await import('react-dom/client');

const { Chip, CopyButton, Dialog, ScreenSkeleton, GoogleWindowWait, Field, SampleBanner, SectionTabs, SuggestionChip, Toast, StatusPill, splitTabs, useToast } = await import('../src/react/ui');
const { Clock, History, Home, Phone, Shield, Wrench } = await import('lucide-react');
const { ClockProvider, useClock } = await import('../src/react/clock');
const { CalendarImportDialog, CalendarHint } = await import('../src/react/calendar');
const { ContactDialog, ContactCard, ContactSelect } = await import('../src/react/contacts');
const { PhotoPicker } = await import('../src/react/photo');
const { SuggestionsCard } = await import('../src/react/suggestions');

// A root left mounted keeps its window listeners (a dialog's Escape) and answers the next test's
// events, so each render, and the end of each test, unmounts the ones before it.
const roots: Root[] = [];
const unmountAll = () => act(() => roots.splice(0).forEach((r) => r.unmount()));
afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

function render(node: React.ReactNode): { root: Root; el: HTMLElement } {
  unmountAll();
  document.body.innerHTML = '<div id="app"></div>';
  const el = document.getElementById('app')!;
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(node));
  return { root, el };
}
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const byText = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;

describe('ScreenSkeleton', () => {
  test('a busy placeholder of rows that says what is loading to screen readers only', () => {
    const { el, root } = render(<ScreenSkeleton rows={4} label="Loading the household's day." />);
    const section = el.querySelector('section')!;
    expect(section.getAttribute('role')).toBe('status');
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(section.getAttribute('aria-label')).toBe('Loading…');
    expect(section.querySelector('.sr-only')!.textContent).toBe("Loading the household's day.");
    expect(section.querySelectorAll('li')).toHaveLength(4);
    expect(section.querySelector('ul')!.getAttribute('aria-hidden')).toBe('true');
    act(() => root.unmount());
  });
});

describe('Dialog', () => {
  test('titled, focuses the first field, closes on Escape and on the scrim', () => {
    const onClose = mock(() => {});
    render(
      <Dialog title="New contact" onClose={onClose}>
        <input id="first" />
      </Dialog>,
    );
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('New contact');
    expect(document.activeElement?.id).toBe('first');
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(1);
    click(document.querySelector('[role=dialog]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    click(document.querySelector('[aria-label=Close]'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Dialog focus', () => {
  // A new-job form: a name, then chips and a select further down. The parent re-renders on its own
  // (a clock tick, a snapshot) and hands the dialog a new onClose arrow each time, as apps do.
  let rerenderParent = () => {};
  function NewJob({ onClose }: { onClose: () => void }) {
    const [name, setName] = useState('');
    const [kind, setKind] = useState('after-done');
    const [unit, setUnit] = useState('month');
    return (
      <Dialog title="New job" onClose={onClose}>
        <Field label="What">
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Chip active={kind === 'after-done'} onClick={() => setKind('after-done')}>Counted from done</Chip>
        <Chip active={kind === 'fixed'} onClick={() => setKind('fixed')}>On set dates</Chip>
        <select id="unit" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="month">months</option>
          <option value="week">weeks</option>
        </select>
      </Dialog>
    );
  }
  function Parent({ onClose }: { onClose: () => void }) {
    const [, setTick] = useState(0);
    rerenderParent = () => setTick((t) => t + 1);
    return <NewJob onClose={() => onClose()} />;
  }
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  /** A tap: focus moves to what was tapped, then it is clicked. */
  const tap = (el: HTMLElement) =>
    act(() => {
      el.focus();
      el.click();
    });
  const onPhone = (coarse: boolean) => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...real.call(window, q), matches: coarse && q === '(pointer: coarse)' })) as typeof window.matchMedia;
    return () => void (window.matchMedia = real);
  };

  test('on a phone: no field takes focus on open, and focus stays on the chip or select tapped while the parent re-renders', () => {
    const restore = onPhone(true);
    try {
      const onClose = mock(() => {});
      render(<Parent onClose={onClose} />);
      const panel = document.querySelector<HTMLElement>('[role=dialog]')!;
      const name = document.getElementById('name') as HTMLInputElement;
      // The dialog holds focus, so no on-screen keyboard until a field is tapped.
      expect(document.activeElement).toBe(panel);

      type(name, 'Change HVAC filter');
      expect(name.value).toBe('Change HVAC filter');
      panel.scrollTop = 240;
      const chip = byText('On set dates')!;
      tap(chip);
      expect(chip.getAttribute('aria-pressed')).toBe('true');
      for (let i = 0; i < 3; i++) act(() => rerenderParent());
      expect(document.activeElement).toBe(chip);
      expect(document.activeElement).not.toBe(name);

      const unit = document.getElementById('unit') as HTMLSelectElement;
      tap(unit);
      act(() => {
        unit.value = 'week';
        unit.dispatchEvent(new Event('change', { bubbles: true }));
      });
      act(() => rerenderParent());
      expect(document.activeElement).toBe(unit);
      expect(panel.scrollTop).toBe(240);

      // The newest onClose is the one Escape calls.
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('with a mouse: the first field takes focus once, and re-renders leave focus where it was moved', () => {
    const restore = onPhone(false);
    try {
      render(<Parent onClose={() => {}} />);
      const name = document.getElementById('name') as HTMLInputElement;
      expect(document.activeElement).toBe(name);
      type(name, 'Clean gutters');
      const unit = document.getElementById('unit') as HTMLSelectElement;
      tap(unit);
      for (let i = 0; i < 3; i++) act(() => rerenderParent());
      expect(document.activeElement).toBe(unit);
    } finally {
      restore();
    }
  });

  test('a field focused with autoFocus keeps it', () => {
    const restore = onPhone(false);
    try {
      render(
        <Dialog title="New list" onClose={() => {}}>
          <input id="first" />
          <input id="second" autoFocus />
        </Dialog>,
      );
      expect(document.activeElement?.id).toBe('second');
    } finally {
      restore();
    }
  });
});

describe('Toast', () => {
  function Harness({ onUndo }: { onUndo: () => void }) {
    const t = useToast();
    return (
      <>
        <button onClick={() => t.notify('Deleted Example Vet', onUndo)}>Delete</button>
        <button onClick={() => t.fail("Couldn't save.")}>Fail</button>
        <Toast toast={t.toast} onDone={t.clear} />
      </>
    );
  }

  test('Undo runs and dismisses; errors show without Undo', () => {
    const onUndo = mock(() => {});
    render(<Harness onUndo={onUndo} />);
    click(byText('Delete'));
    expect(document.querySelector('[aria-live]')!.textContent).toContain('Deleted Example Vet');
    click(byText('Undo'));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[aria-live]')!.textContent).toBe('');
    click(byText('Fail'));
    expect(document.querySelector('.bg-red-700')!.textContent).toBe("Couldn't save.");
    expect(byText('Undo')).toBeNull();
  });
});

test('section tabs mark the current one and report taps', () => {
  const onTab = mock((_: string) => {});
  render(<SectionTabs tabs={[{ id: 'a', label: 'Overview' }, { id: 'b', label: 'History' }]} tab="a" onTab={onTab} />);
  expect(document.querySelector('[aria-current=page]')!.textContent).toBe('Overview');
  expect(document.querySelector('nav')!.getAttribute('slot')).toBe('nav');
  click(byText('History'));
  expect(onTab).toHaveBeenCalledWith('b');
  render(<SectionTabs tabs={[]} tab="a" onTab={onTab} />);
  expect(document.querySelector('nav')).toBeNull();
});

describe('section tabs on phones: the bottom bar', () => {
  const six = [
    { id: 'overview', label: 'Overview', icon: Home, primary: true },
    { id: 'upkeep', label: 'Upkeep', icon: Wrench, primary: true },
    { id: 'regular', label: 'Regular', icon: Clock, primary: true },
    { id: 'history', label: 'History', icon: History, primary: true },
    { id: 'warranties', label: 'Warranties', icon: Shield },
    { id: 'contacts', label: 'Contacts', icon: Phone },
  ];
  const bar = () => document.querySelector<HTMLElement>('nav[data-hh-bottom-nav]');
  const barButtons = () => Array.from(bar()!.querySelectorAll('button'));

  test('four or fewer all fit; else the primaries, or the first four when none is marked', () => {
    const four = six.slice(0, 4).map(({ primary: _, ...t }) => t);
    expect(splitTabs(four)).toEqual({ bar: four, more: [] });
    expect(splitTabs(six).bar.map((t) => t.id)).toEqual(['overview', 'upkeep', 'regular', 'history']);
    expect(splitTabs(six).more.map((t) => t.id)).toEqual(['warranties', 'contacts']);
    const picked = six.map((t) => ({ ...t, primary: t.id === 'contacts' || t.id === 'overview' }));
    expect(splitTabs(picked)).toEqual({ bar: [picked[0], picked[5]], more: picked.slice(1, 5) });
    const unmarked = six.map(({ primary: _, ...t }) => t);
    expect(splitTabs(unmarked).bar.map((t) => t.id)).toEqual(['overview', 'upkeep', 'regular', 'history']);
  });

  test('a labelled nav with icons, the current one marked, outside the app bar slot', () => {
    const onTab = mock((_: string) => {});
    const { root } = render(<SectionTabs tabs={six.slice(0, 3)} tab="upkeep" onTab={onTab} />);
    expect(bar()!.getAttribute('aria-label')).toBe('Sections');
    expect(bar()!.hasAttribute('slot')).toBe(false);
    expect(bar()!.parentElement).toBe(document.body);
    expect(document.querySelector('nav[slot=nav]')!.hasAttribute('data-bottom-nav')).toBe(true);
    expect(barButtons().map((b) => b.textContent)).toEqual(['Overview', 'Upkeep', 'Regular']);
    expect(barButtons().every((b) => b.querySelector('svg'))).toBe(true);
    expect(bar()!.querySelector('[aria-current=page]')!.textContent).toBe('Upkeep');
    click(barButtons()[2]);
    expect(onTab).toHaveBeenCalledWith('regular');
    expect(document.documentElement.hasAttribute('data-hh-bottom-nav')).toBe(true);
    act(() => root.unmount());
    expect(document.documentElement.hasAttribute('data-hh-bottom-nav')).toBe(false);
  });

  test('short labels in the bar, the full one in the app bar', () => {
    render(<SectionTabs tabs={[{ id: 'a', label: 'Appointments', short: 'Visits', icon: Clock }]} tab="a" onTab={() => {}} />);
    expect(barButtons()[0].textContent).toBe('Visits');
    expect(document.querySelector('nav[slot=nav] button')!.textContent).toBe('Appointments');
  });

  test('More opens a sheet with the rest; picking one closes it', () => {
    const onTab = mock((_: string) => {});
    render(<SectionTabs tabs={six} tab="overview" onTab={onTab} />);
    expect(barButtons().map((b) => b.textContent)).toEqual(['Overview', 'Upkeep', 'Regular', 'History', 'More']);
    const more = barButtons()[4];
    expect(more.getAttribute('aria-label')).toBe('More');
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    click(more);
    const sheet = document.querySelector('[role=dialog]')!;
    expect(sheet.getAttribute('aria-label')).toBe('More');
    const items = Array.from(sheet.querySelectorAll('ul button'));
    expect(items.map((b) => b.textContent)).toEqual(['Warranties', 'Contacts']);
    click(items[1]);
    expect(onTab).toHaveBeenCalledWith('contacts');
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });

  test('a section under More marks More and itself in the sheet', () => {
    render(<SectionTabs tabs={six} tab="warranties" onTab={() => {}} />);
    expect(bar()!.querySelector('[aria-current=page]')).toBeNull();
    const more = barButtons()[4];
    expect(more.getAttribute('aria-label')).toBe('More, showing Warranties');
    click(more);
    expect(document.querySelector('[role=dialog] [aria-current=page]')!.textContent).toBe('Warranties');
  });

  test('no tabs, no bar', () => {
    render(<SectionTabs tabs={[]} tab="" onTab={() => {}} />);
    expect(bar()).toBeNull();
  });
});

test('status pill labels only what needs attention', () => {
  render(<StatusPill state="overdue" />);
  expect(document.body.textContent).toBe('Overdue');
  render(<StatusPill state="ok" />);
  expect(document.body.textContent).toBe('');
});

test('the clock reads from the provider and moves on writes', () => {
  let t = 1000;
  let seen: ReturnType<typeof useClock> | null = null;
  function Show() {
    seen = useClock();
    return <span>{seen.now}</span>;
  }
  render(
    <ClockProvider read={() => t}>
      <Show />
    </ClockProvider>,
  );
  expect(seen!.now).toBe(1000);
  t = 5000;
  act(() => void seen!.read());
  expect(document.body.textContent).toBe('5000');
});

describe('calendar', () => {
  const m = (id: string, start: number): CalendarMatch => ({ id, title: `Visit ${id}`, start, allDay: true, location: '', description: '', link: `https://example.com/${id}`, calendarName: 'Family' });

  test('import lists events not yet imported, soonest first, with Add all', () => {
    const onAdd = mock((_: CalendarMatch[]) => {});
    render(
      <CalendarImportDialog
        state={{ status: 'done', matches: [m('b', 2e12), m('a', 1e12), m('c', 3e12)] }}
        records={[{ title: 'x', calendarEventId: 'c' }]}
        intro="Vet visits from last week to a year ahead."
        noneFound="No pet events found."
        allImported="Every pet event is already in Pet."
        onRetry={() => {}}
        onAdd={onAdd}
        onClose={() => {}}
      />,
    );
    expect(Array.from(document.querySelectorAll('[aria-label="Calendar events"] li p.font-medium')).map((p) => p.textContent)).toEqual(['Visit a', 'Visit b']);
    click(byText('Add all 2'));
    expect(onAdd.mock.calls[0][0].map((x) => x.id)).toEqual(['a', 'b']);
  });

  test('says when everything is already in', () => {
    render(
      <CalendarImportDialog
        state={{ status: 'done', matches: [m('c', 3e12)] }}
        records={[{ title: 'x', calendarEventId: 'c' }]}
        intro="i"
        noneFound="No pet events found."
        allImported="Every pet event is already in Pet."
        onRetry={() => {}}
        onAdd={() => {}}
        onClose={() => {}}
      >
        <p id="extra">Set Biscuit's birthday</p>
      </CalendarImportDialog>,
    );
    expect(document.getElementById('extra')!.textContent).toBe("Set Biscuit's birthday");
    expect(document.querySelector('[role=status]')!.textContent).toBe('Every pet event is already in Pet.');
  });

  test('the hint before Google first asks names the app', () => {
    localStorage.clear();
    render(<CalendarHint app="Pet" available />);
    expect(document.body.textContent).toBe('Google will ask once to let Pet read your calendar. Pet never changes it.');
    localStorage.setItem('pet-calendar-allowed', '1');
    render(<CalendarHint app="Pet" available />);
    expect(document.body.textContent).toBe('');
    render(<CalendarHint app="Pet" available={false} />);
    expect(document.body.textContent).toBe('Sign in to search your calendar.');
  });

  test('the hint names the app in the page language while the key stays the app', () => {
    localStorage.clear();
    render(<CalendarHint app="Baby" name="Bebé" available />);
    expect(document.body.textContent).toBe('Google will ask once to let Bebé read your calendar. Bebé never changes it.');
    localStorage.setItem('baby-calendar-allowed', '1');
    render(<CalendarHint app="Baby" name="Bebé" available />);
    expect(document.body.textContent).toBe('');
  });
});

describe('contacts', () => {
  test('the dialog saves trimmed input shown in the app, keeping other apps, and offers the roles', () => {
    const onSave = mock((_: unknown) => {});
    const contact = { id: 'c', name: '  Example Vet Clinic ', website: 'example.com', apps: ['baby'], createdAt: 1, by: 'x' };
    render(<ContactDialog contact={contact} app="pet" roles={['Vet', 'Groomer']} onSave={onSave} onClose={() => {}} />);
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('Edit contact');
    click(byText('Groomer'));
    expect(byText('Groomer')!.getAttribute('aria-pressed')).toBe('true');
    click(byText('Save'));
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: 'Example Vet Clinic', role: 'Groomer', website: 'https://example.com', apps: ['baby', 'pet'] });
  });

  test('a new contact needs a name', () => {
    render(<ContactDialog contact={null} app="pet" roles={[]} title={{ add: 'New shop', edit: 'Edit shop' }} onSave={() => {}} onClose={() => {}} />);
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('New shop');
    expect(byText('Save')!.hasAttribute('disabled')).toBe(true);
  });

  const typeInto = (el: HTMLTextAreaElement | HTMLInputElement, value: string) =>
    act(() => {
      // React skips the change when its value tracker already holds the new value; reset it first.
      el.value = value;
      (el as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue('');
      // Where React was first loaded without a DOM (another test file), it watches focus and keys instead of input.
      el.focus();
      for (const type of ['input', 'change', 'keyup']) el.dispatchEvent(new Event(type, { bubbles: true }));
    });
  const field = (label: string) => Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith(label))?.querySelector('input') ?? null;

  test('pasted listing text fills the fields and shows what was not used', () => {
    const onSave = mock((_: unknown) => {});
    render(<ContactDialog contact={null} app="pet" roles={['Vet']} onSave={onSave} onClose={() => {}} />);
    click(byText('Paste listing text'));
    const box = document.querySelector('textarea[aria-label="Listing text"]') as HTMLTextAreaElement;
    typeInto(box, 'Example Animal Hospital\n4.6 (512)\n1 Example Way, Springfield, IL 62704\n(217) 555-0100\nexample.com\n"Lovely staff, very kind to our dog."');
    click(byText('Fill in'));
    expect(document.body.textContent).toContain('Filled in the name, phone, website, and address from the pasted text. Check them before saving.');
    expect(document.querySelector('details:not([open]) summary')?.textContent).toBe("Show the text that wasn't used");
    expect(document.body.textContent).toContain('Lovely staff, very kind to our dog.');
    click(byText('Save'));
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: 'Example Animal Hospital', phone: '(217) 555-0100', website: 'https://example.com', address: '1 Example Way, Springfield, IL 62704', apps: ['pet'] });
  });

  test('a screenshot is read and fills the fields; a failed read can be retried', async () => {
    let fail = true;
    const readScreenshot = mock(async () => {
      if (fail) throw new Error('offline');
      return { name: 'Example Vet', phone: '(217) 555-0101', confidence: 0.6, unparsed: [], ignored: [] };
    });
    render(<ContactDialog contact={null} app="pet" roles={[]} readScreenshot={readScreenshot} onSave={() => {}} onClose={() => {}} />);
    expect(document.body.textContent).toContain('Take a screenshot of the business in Google Maps, then choose it here.');
    const input = document.querySelector('input[aria-label="Screenshot of the business"]') as HTMLInputElement;
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(document.querySelector('[role=alert]')!.textContent).toContain("Couldn't read the screenshot");
    fail = false;
    await act(async () => click(byText('Try again')));
    expect(readScreenshot).toHaveBeenCalledTimes(2);
    expect(field('Name')!.value).toBe('Example Vet');
    expect(field('Phone')!.value).toBe('(217) 555-0101');
    expect(document.body.textContent).toContain('Filled in the name and phone from the screenshot.');
  });

  test('a screenshot with nothing recognisable says so', async () => {
    render(<ContactDialog contact={null} app="pet" roles={[]} readScreenshot={async () => ({ confidence: 0, unparsed: ['lorem'], ignored: [] })} onSave={() => {}} onClose={() => {}} />);
    const input = document.querySelector('input[aria-label="Screenshot of the business"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 's.png')], configurable: true });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(document.body.textContent).toContain("Couldn't find a business's details in the screenshot.");
  });

  test('a shared place starts a new contact, with its hours in the notes', () => {
    const prefill = { name: 'Example Vet', mapsUrl: 'https://maps.app.goo.gl/x', hours: 'Mon 8 AM–6 PM', confidence: 0.55, unparsed: ['Here is the vet'], ignored: [] };
    render(<ContactDialog contact={null} app="pet" roles={[]} prefill={prefill} onSave={() => {}} onClose={() => {}} />);
    expect(field('Name')!.value).toBe('Example Vet');
    expect(document.querySelector('textarea')!.value).toBe('Hours: Mon 8 AM–6 PM');
    expect(document.body.textContent).toContain('from what was shared');
    expect(document.body.textContent).toContain('Here is the vet');
  });

  test('the card links phone, website and the map', () => {
    render(
      <ContactCard
        contact={{ id: 'c', name: 'Example Vet', phone: '+1 (555) 010-0100', website: 'https://www.example.com/', address: '1 Example Way', apps: ['pet'], createdAt: 1, by: 'x' }}
        role="Vet"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs[0]).toBe('tel:+15550100100');
    expect(hrefs).toContain('https://www.example.com/');
    expect(document.body.textContent).toContain('example.com');
    expect(hrefs.some((h) => h?.startsWith('https://www.google.com/maps/search/'))).toBe(true);
  });
});

describe('PhotoPicker', () => {
  test('choose, Use photo saves the small data URL; Remove photo clears it', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };
    g.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
    g.OffscreenCanvas = class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob({ type }: { type: string }) {
        return new Blob([new Uint8Array(1000)], { type });
      }
    };
    try {
      const saves: string[] = [];
      let removed = 0;
      render(<PhotoPicker photo={null} fallback={<span>B</span>} label="Biscuit's photo" pick={async () => new Blob(['x'])} onSave={(d) => saves.push(d)} onRemove={() => removed++} />);
      expect(document.querySelector('[aria-label="Add Biscuit\'s photo"]')).not.toBeNull();
      await act(async () => click(byText('Choose photo')));
      expect(document.querySelector('input[type="range"]')).not.toBeNull();
      await act(async () => click(byText('Use photo')));
      expect(saves).toHaveLength(1);
      expect(saves[0].startsWith('data:image/webp;base64,')).toBe(true);

      render(<PhotoPicker photo={saves[0]} fallback={<span>B</span>} label="Biscuit's photo" onSave={() => {}} onRemove={() => removed++} />);
      expect(document.querySelector('img')?.getAttribute('src')).toBe(saves[0]);
      click(byText('Remove photo'));
      expect(removed).toBe(1);
    } finally {
      Object.assign(g, saved);
    }
  });
});

test('the React components and the Tailwind theme follow the design language', () => {
  const files = readdirSync('src/react').map((f) => `src/react/${f}`).concat('src/tailwind.css');
  const findings = files.flatMap((f) => checkSource(readFileSync(f, 'utf8'), f.endsWith('.css') ? 'style' : 'script').map((x) => `${f}:${x.line} ${x.rule} ${x.text}`));
  expect(findings).toEqual([]);
});

describe('NotificationsCard', () => {
  test('says when the app has no VAPID key, and explains an unsupported device instead of a button', async () => {
    const { NotificationsCard } = await import('../src/react/push');
    const props = { db: {} as never, householdId: 'h1', user: { email: 'alex@example.com' }, app: 'tasks', offText: 'Get a notification here.', onText: 'On.' };
    const first = render(<NotificationsCard {...props} vapidKey={undefined} />);
    expect(document.body.textContent).toContain('Notifications are not set up for this app yet.');
    // Every app's card leads to the portal's one place to manage notifications.
    expect(document.querySelector('a[href="/notifications"]')?.textContent).toBe('Manage in Huishouden');
    act(() => first.root.unmount());
    const second = render(<NotificationsCard {...props} vapidKey="key" />);
    // happy-dom has no Push API, so the device is unsupported: the reason shows, not a Turn on button.
    expect(byText('Turn on')).toBeNull();
    expect(document.querySelector('section[aria-label="Notifications on this device"] p')?.textContent?.length).toBeGreaterThan(10);
    act(() => second.root.unmount());
  });
});

describe('SampleBanner', () => {

  test('phones: the chip and the short text, the sentence on a tap; wider: the sentence beside the chip', () => {
    const { root } = render(<SampleBanner text="Two invented pets. Nothing is saved. Sign in to use your household’s own." />);
    const short = document.querySelector('[data-sample-short]') as HTMLButtonElement;
    expect(document.querySelector('[data-sample-chip]')!.textContent).toBe('Sample data');
    expect(short.textContent).toContain('Nothing is saved.');
    expect(short.className).toContain('sm:hidden');
    const wide = Array.from(document.querySelectorAll('p')).find((p) => p.className.includes('sm:block'))!;
    expect(wide.textContent).toContain('Two invented pets.');
    expect(short.getAttribute('aria-expanded')).toBe('false');
    click(short);
    expect(short.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(document.querySelectorAll('p')).filter((p) => p.textContent?.includes('Two invented pets.'))).toHaveLength(2);
    act(() => root.unmount());
  });

  test('a sign-in error takes the text’s place at every width', () => {
    const { root } = render(<SampleBanner text="An invented house." notice="Sign-in was cancelled." />);
    expect(document.querySelector('[data-sample-short]')).toBeNull();
    expect(document.querySelector('[role="note"]')!.textContent).toBe('Sample dataSign-in was cancelled.');
    act(() => root.unmount());
  });
});

test('a suggestion can say what its add button does', () => {
  const added: string[] = [];
  const items = [{ id: 'a', title: 'Garbage out' }, { id: 'b', title: 'Lawn service' }];
  const { root } = render(
    <SuggestionsCard
      suggestions={items}
      idOf={(i) => i.id}
      titleOf={(i) => i.title}
      detailOf={() => null}
      lead="Looks regular"
      label="Regular events in your calendar"
      moreLabel="More"
      icon={null}
      onAdd={(i) => added.push(i.id)}
      onDismiss={() => {}}
      addAs={(i) => (i.id === 'a' ? { label: 'Use as prep', ariaLabel: 'Use Garbage out as prep for Garbage pickup' } : null)}
    />,
  );
  const prep = document.querySelector('[aria-label="Use Garbage out as prep for Garbage pickup"]');
  expect(prep!.textContent).toBe('Use as prep');
  click(prep);
  expect(added).toEqual(['a']);
  expect(document.querySelector('[aria-label="Add Lawn service"]')!.textContent?.trim()).toBe('Add');
  act(() => root.unmount());
});

describe('Chip', () => {
  test('says whether it is pressed, and, when it opens something, whether that is open', () => {
    const { el } = render(
      <div>
        <Chip active onClick={() => {}}>Today</Chip>
        <Chip active={false} expanded onClick={() => {}}>Pick a date</Chip>
      </div>,
    );
    const [plain, disclosure] = Array.from(el.querySelectorAll('button'));
    expect(plain.getAttribute('aria-pressed')).toBe('true');
    expect(plain.hasAttribute('aria-expanded')).toBe(false);
    expect(disclosure.getAttribute('aria-pressed')).toBe('false');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('SuggestionChip', () => {
  const pointer = (type: string, init: PointerEventInit = {}) => new PointerEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10, ...init });
  function setup(editing = false) {
    const calls: string[] = [];
    const { root } = render(<SuggestionChip label="Milk" editing={editing} onPick={() => calls.push('pick')} onRemove={() => calls.push('remove')} hint="It comes back once it is added again." />);
    return { calls, root, chip: document.querySelector('[aria-label="Add Milk"]') as HTMLElement };
  }

  test('a tap picks it', () => {
    const { calls, root, chip } = setup();
    act(() => void chip.dispatchEvent(pointer('pointerdown')));
    act(() => void chip.dispatchEvent(pointer('pointerup')));
    click(chip);
    expect(calls).toEqual(['pick']);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    act(() => root.unmount());
  });

  test('a long press opens the sheet without picking, and its action removes', async () => {
    const { calls, root, chip } = setup();
    act(() => void chip.dispatchEvent(pointer('pointerdown')));
    await act(() => new Promise((r) => setTimeout(r, 550)));
    act(() => void chip.dispatchEvent(pointer('pointerup')));
    click(chip);
    expect(calls).toEqual([]);
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('Milk');
    expect(document.body.textContent).toContain('It comes back once it is added again.');
    click(byText("Don't suggest Milk"));
    expect(calls).toEqual(['remove']);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    // The next tap picks again.
    act(() => void chip.dispatchEvent(pointer('pointerdown')));
    click(chip);
    expect(calls).toEqual(['remove', 'pick']);
    act(() => root.unmount());
  });

  test('moving the finger is a scroll, not a press', async () => {
    const { root, chip } = setup();
    act(() => void chip.dispatchEvent(pointer('pointerdown')));
    act(() => void chip.dispatchEvent(pointer('pointermove', { clientX: 40 })));
    await act(() => new Promise((r) => setTimeout(r, 550)));
    expect(document.querySelector('[role=dialog]')).toBeNull();
    act(() => root.unmount());
  });

  test('a right-click opens the sheet', () => {
    const { root, chip } = setup();
    act(() => void chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    act(() => root.unmount());
  });

  test('editing shows an × that removes it at once', () => {
    const { calls, root } = setup(true);
    click(document.querySelector('[aria-label="Don\'t suggest Milk"]'));
    expect(calls).toEqual(['remove']);
    act(() => root.unmount());
  });
});

describe('CopyButton', () => {
  test('copies the text and says so', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    render(<CopyButton text="landlord@example.com" what="the Zelle email" />);
    const button = document.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Copy the Zelle email');
    await act(async () => button.click());
    expect(written).toEqual(['landlord@example.com']);
    expect(button.getAttribute('aria-label')).toBe('Copied');
  });
});

describe('ContactSelect', () => {
  const contacts = [
    { id: 'a', name: 'Example Rentals', role: 'Landlord', apps: ['home'], createdAt: 1, by: 'x@example.com' },
    { id: 'b', name: 'Sam', apps: ['bills'], createdAt: 1, by: 'x@example.com' },
  ];
  test('lists contacts with their roles, "No one" first, and keeps a removed one', () => {
    const onChange = mock((_id: string) => {});
    render(<ContactSelect value="gone" contacts={contacts} onChange={onChange} roleLabel={(r) => r.toUpperCase()} label="Pay to" />);
    const select = document.querySelector('select')!;
    expect(select.getAttribute('aria-label')).toBe('Pay to');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['No one', 'Example Rentals (LANDLORD)', 'Sam', 'A removed contact']);
    act(() => {
      select.value = 'a';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('a');
  });
});

describe('GoogleWindowWait', () => {
  test('after a few seconds of waiting, says the window may be behind and brings it back', async () => {
    const onShow = mock(() => {});
    const { root } = render(<GoogleWindowWait waiting onShow={onShow} delayMs={20} />);
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('may be behind this window');
    click(byText('Show Google’s window'));
    expect(onShow).toHaveBeenCalledTimes(1);
    act(() => root.render(<GoogleWindowWait waiting={false} onShow={onShow} delayMs={20} />));
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  test('with Continue in this tab: offered while waiting, and alone once the window was blocked', async () => {
    const onShow = mock(() => {});
    const here = mock(() => {});
    const { root } = render(<GoogleWindowWait waiting onShow={onShow} onContinueHere={here} delayMs={10} />);
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('or continue in this tab instead');
    click(byText('Continue in this tab'));
    expect(here).toHaveBeenCalledTimes(1);
    act(() => root.render(<GoogleWindowWait waiting={false} blocked onShow={onShow} onContinueHere={here} />));
    expect(byText('Show Google’s window')).toBeNull();
    click(byText('Continue in this tab'));
    expect(here).toHaveBeenCalledTimes(2);
  });
});

const ui = await import('../src/react/ui');
describe('Completion', () => {
  const names = () => Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());

  test('open and done carry different buttons and names, never aria-pressed', () => {
    const onDone = mock(() => {});
    const onUndo = mock(() => {});
    const Row = ({ done }: { done: boolean }) => (
      <ul>
        <ui.CompletionRow name="Take the garbage out" title="Take the garbage out" meta="Tonight by 7 PM" done={done} by="You" at="8:10 PM" onDone={onDone} onUndo={onUndo} />
      </ul>
    );
    const { root } = render(<Row done={false} />);
    expect(names()).toEqual(['Mark Take the garbage out done']);
    const open = document.querySelector('[data-complete=open]')!;
    expect(open.textContent).toBe('Mark done');
    expect(open.className).toContain('border-primary');
    expect(open.className).not.toContain('bg-primary');
    expect(document.querySelector('[aria-pressed]')).toBeNull();
    expect(document.querySelector('[data-done-badge]')).toBeNull();
    click(open);
    expect(onDone).toHaveBeenCalledTimes(1);

    act(() => root.render(<Row done />));
    expect(names()).toEqual(['Undo done for Take the garbage out']);
    expect(document.querySelector('[data-complete=open]')).toBeNull();
    expect(document.querySelector('[data-done-badge=done]')).not.toBeNull();
    expect(document.querySelector('li')!.getAttribute('data-completion')).toBe('done');
    expect(document.querySelector('li')!.textContent).toContain('Done by you · 8:10 PM');
    expect(document.querySelector('li')!.textContent).not.toContain('Tonight by 7 PM');
    expect(document.querySelector('[aria-pressed]')).toBeNull();
    click(document.querySelector('[data-complete=undo]'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  test('a domain verb and name; no Undo once it has run out; skipped says so', () => {
    const { root } = render(<ui.CompleteButton done={false} name="Heartgard" verb="Give" label="Give Heartgard to Biscuit" onDone={() => {}} />);
    expect(names()).toEqual(['Give Heartgard to Biscuit']);
    expect(document.querySelector('button')!.textContent).toBe('Give');
    act(() => root.render(<ui.CompleteButton done name="Heartgard" onDone={() => {}} />));
    expect(document.querySelectorAll('button').length).toBe(0);
    act(() =>
      root.render(
        <ul>
          <ui.CompletionRow name="Recycling" title="Recycling" done skipped by="Sam" onDone={() => {}} onUndo={() => {}} />
        </ul>,
      ),
    );
    expect(names()).toEqual(['Undo skip for Recycling']);
    expect(document.querySelector('[data-done-badge=skipped]')).not.toBeNull();
    expect(document.querySelector('li')!.textContent).toContain('Skipped by Sam');
  });

  test('done sorts after open; all done folds to one line that opens again', () => {
    type Item = { id: string; done: boolean };
    const List = ({ items }: { items: Item[] }) => (
      <ui.CompletionList items={items} isDone={(x) => x.done} label="Tonight" allDone="All done for tonight">
        {(x) => <ui.CompletionRow key={x.id} name={x.id} title={x.id} done={x.done} onDone={() => {}} onUndo={() => {}} />}
      </ui.CompletionList>
    );
    const { root } = render(<List items={[{ id: 'a', done: true }, { id: 'b', done: false }, { id: 'c', done: true }, { id: 'd', done: false }]} />);
    expect(Array.from(document.querySelectorAll('li')).map((li) => li.textContent!.charAt(0))).toEqual(['b', 'd', 'a', 'c']);
    act(() => root.render(<List items={[{ id: 'a', done: true }, { id: 'b', done: true }]} />));
    expect(document.querySelectorAll('li').length).toBe(0);
    const summary = document.querySelector('[aria-expanded]')!;
    expect(summary.textContent).toContain('All done for tonight');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    click(summary);
    expect(document.querySelectorAll('li').length).toBe(2);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
  });

  test('extra actions wrap below the title on phones; the fold can say its own word', () => {
    render(
      <ul>
        <ui.CompletionRow name="Metformin" title="Metformin" done={false} actions={<button type="button">Skip</button>} onDone={() => {}} />
      </ul>,
    );
    expect(document.querySelector('li')!.className).toContain('flex-wrap');
    render(
      <ui.CompletionList items={[1]} isDone={() => true} label="Bills" allDone="All paid" showDone={(n) => `Show ${n} paid`}>
        {(x) => <ui.CompletionRow key={x} name="Power" title="Power" done onDone={() => {}} />}
      </ui.CompletionList>,
    );
    expect(document.querySelector('[aria-expanded]')!.textContent).toContain('Show 1 paid');
  });

  test('canUndoDone: six hours, and never past the next one', () => {
    const at = 1_000_000_000_000;
    expect(ui.canUndoDone(at, at + 5 * 3_600_000)).toBe(true);
    expect(ui.canUndoDone(at, at + 6 * 3_600_000)).toBe(false);
    expect(ui.canUndoDone(at, at + 3_600_000, { until: at + 1_800_000 })).toBe(false);
    expect(ui.canUndoDone(undefined, at)).toBe(false);
    expect(ui.openFirst([1, 2, 3, 4], (n) => n % 2 === 1)).toEqual([2, 4, 1, 3]);
    expect(ui.doneLine({ by: 'Jo', at: 'at 8 PM' })).toBe('Done by Jo · at 8 PM');
    expect(ui.doneLine({})).toBe('Done');
    expect(ui.doneLine({ by: 'You', at: '8:10 PM' })).toBe('Done by you · 8:10 PM');
    expect(ui.doneLine({ byMe: true, skipped: true })).toBe('Skipped by you');
    expect(ui.doneLine({ by: 'Sam', at: '8:10 PM' })).toBe('Done by Sam · 8:10 PM');
  });
});
