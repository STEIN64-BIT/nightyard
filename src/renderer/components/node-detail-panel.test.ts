import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Minimal DOM stub (node env — no jsdom) ────────────────────────────────────
type Listener = (e?: Event) => void;

class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  title = '';
  private _innerHTML = '';
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private listeners = new Map<string, Listener[]>();
  private attrs = new Map<string, string>();

  constructor(tag: string) { this.tagName = tag; }

  append(...els: FakeElement[]): void {
    for (const e of els) { e.parent = this; this.children.push(e); }
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }

  // When innerHTML is set, parse class names out of the html to build children.
  // This is sufficient for querySelector('.class') to work.
  get innerHTML(): string { return this._innerHTML; }
  set innerHTML(html: string) {
    this._innerHTML = html;
    this.children = [];
    // Match any opening tag with a class attribute
    const elRegex = /<(\w+)([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = elRegex.exec(html)) !== null) {
      const tag = m[1];
      const attrs = m[2];
      const classMatch = /class="([^"]*)"/.exec(attrs);
      if (classMatch) {
        const child = new FakeElement(tag);
        child.className = classMatch[1];
        // Parse any data- or aria- attributes stored on the child.
        const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
        let am: RegExpExecArray | null;
        while ((am = attrRegex.exec(attrs)) !== null) {
          child.attrs.set(am[1], am[2]);
        }
        child.parent = this;
        this.children.push(child);
      }
    }
  }

  querySelector(sel: string): FakeElement | null {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this._find(el => el.className.split(/\s+/).includes(cls));
    }
    return this._find(el => el.tagName === sel);
  }

  private _find(pred: (el: FakeElement) => boolean): FakeElement | null {
    for (const c of this.children) {
      if (pred(c)) return c;
      const r = c._find(pred);
      if (r) return r;
    }
    return null;
  }

  addEventListener(evt: string, cb: Listener): void {
    const list = this.listeners.get(evt) ?? [];
    list.push(cb);
    this.listeners.set(evt, list);
  }

  click(): void {
    for (const cb of this.listeners.get('click') ?? []) cb();
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement { return new FakeElement(tag); }
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('document', new FakeDocument());
});

// Lazy import AFTER stub is installed
async function getModule() {
  vi.resetModules();
  return import('./node-detail-panel.js');
}

describe('renderNodeDetail', () => {
  it('renders note title, preview, and launch button that fires callback', async () => {
    const { renderNodeDetail } = await getModule();
    const onLaunch = vi.fn();
    const el = renderNodeDetail(
      { id: 'A.md', kind: 'note', label: 'A', parentId: null },
      { preview: 'note body text', onLaunch, onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(el.querySelector('.node-detail__title')?.textContent).toBe('A');
    expect(el.querySelector('.node-detail__preview')?.textContent).toContain('note body');
    (el.querySelector('.node-detail__launch') as FakeElement).click();
    expect(onLaunch).toHaveBeenCalledWith('A.md');
  });

  it('hides launch button for tag nodes', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 'tag:x', kind: 'tag', label: '#x', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(el.querySelector('.node-detail__launch')).toBeNull();
  });

  it('close button fires onClose', async () => {
    const { renderNodeDetail } = await getModule();
    const onClose = vi.fn();
    const el = renderNodeDetail(
      { id: 'B.md', kind: 'note', label: 'B', parentId: null },
      { preview: 'some text', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose },
    );
    (el.querySelector('.node-detail__close') as FakeElement).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('close button has aria-label="Close"', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 'D.md', kind: 'note', label: 'D', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    const closeBtn = el.querySelector('.node-detail__close') as FakeElement;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.getAttribute('aria-label')).toBe('Close');
  });

  it('open-note button only appears for notes and fires onOpenNote with id', async () => {
    const { renderNodeDetail } = await getModule();

    // Note node — button should exist and fire with id
    const onOpenNote = vi.fn();
    const noteEl = renderNodeDetail(
      { id: 'C.md', kind: 'note', label: 'C', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote, onClose: vi.fn() },
    );
    const openBtn = noteEl.querySelector('.node-detail__open') as FakeElement;
    expect(openBtn).not.toBeNull();
    openBtn.click();
    expect(onOpenNote).toHaveBeenCalledWith('C.md');

    // Tag node — button should NOT exist
    const tagEl = renderNodeDetail(
      { id: 'tag:y', kind: 'tag', label: '#y', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(tagEl.querySelector('.node-detail__open')).toBeNull();
  });

  it('fires onLaunchWakey and onLaunchSleepy for note nodes', async () => {
    const { renderNodeDetail } = await getModule();
    const onLaunchWakey = vi.fn();
    const onLaunchSleepy = vi.fn();
    const el = renderNodeDetail(
      { id: 'A.md', kind: 'note', label: 'A', parentId: null },
      {
        preview: '',
        onLaunch: vi.fn(),
        onOpenNote: vi.fn(),
        onClose: vi.fn(),
        onLaunchWakey,
        onLaunchSleepy,
      },
    );
    const wakeyBtn = el.querySelector('.node-detail__wakey') as FakeElement;
    const sleepyBtn = el.querySelector('.node-detail__sleepy') as FakeElement;
    expect(wakeyBtn).not.toBeNull();
    expect(sleepyBtn).not.toBeNull();
    wakeyBtn.click();
    expect(onLaunchWakey).toHaveBeenCalledWith('A.md');
    sleepyBtn.click();
    expect(onLaunchSleepy).toHaveBeenCalledWith('A.md');
  });

  it('omits wakey/sleepy buttons when callbacks not provided', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 'A.md', kind: 'note', label: 'A', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(el.querySelector('.node-detail__wakey')).toBeNull();
    expect(el.querySelector('.node-detail__sleepy')).toBeNull();
  });

  it('omits wakey/sleepy buttons for tag nodes even with callbacks', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 'tag:z', kind: 'tag', label: '#z', parentId: null },
      {
        preview: '',
        onLaunch: vi.fn(),
        onOpenNote: vi.fn(),
        onClose: vi.fn(),
        onLaunchWakey: vi.fn(),
        onLaunchSleepy: vi.fn(),
      },
    );
    expect(el.querySelector('.node-detail__wakey')).toBeNull();
    expect(el.querySelector('.node-detail__sleepy')).toBeNull();
  });
});

describe('renderNodeDetail meta & sessions', () => {
  it('renders meta rows as dt/dd pairs', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 's1', kind: 'session', label: 'Fix bug', parentId: 'p1' },
      {
        preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn(),
        meta: [{ label: 'Project', value: 'nightyard' }, { label: 'Status', value: 'working' }],
      },
    );
    const metaEl = el.querySelector('.node-detail__meta') as FakeElement;
    expect(metaEl).not.toBeNull();
    const texts = metaEl.children.map((ch) => ch.textContent);
    expect(texts).toEqual(['Project', 'nightyard', 'Status', 'working']);
  });

  it('removes the meta block when no meta rows are given', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 'A.md', kind: 'note', label: 'A', parentId: null },
      { preview: 'body', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(el.querySelector('.node-detail__meta')).toBeNull();
  });

  it('removes the preview block when preview is empty', async () => {
    const { renderNodeDetail } = await getModule();
    const el = renderNodeDetail(
      { id: 's1', kind: 'session', label: 'S', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(el.querySelector('.node-detail__preview')).toBeNull();
  });

  it('session node with onGoToSession gets a goto button that fires with the id', async () => {
    const { renderNodeDetail } = await getModule();
    const onGoToSession = vi.fn();
    const el = renderNodeDetail(
      { id: 's1', kind: 'session', label: 'S', parentId: 'p1' },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn(), onGoToSession },
    );
    (el.querySelector('.node-detail__goto') as FakeElement).click();
    expect(onGoToSession).toHaveBeenCalledWith('s1');
  });

  it('session node without onGoToSession has no goto button; notes never get one', async () => {
    const { renderNodeDetail } = await getModule();
    const el1 = renderNodeDetail(
      { id: 's1', kind: 'session', label: 'S', parentId: null },
      { preview: '', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn() },
    );
    expect(el1.querySelector('.node-detail__goto')).toBeNull();
    const el2 = renderNodeDetail(
      { id: 'A.md', kind: 'note', label: 'A', parentId: null },
      { preview: 'x', onLaunch: vi.fn(), onOpenNote: vi.fn(), onClose: vi.fn(), onGoToSession: vi.fn() },
    );
    expect(el2.querySelector('.node-detail__goto')).toBeNull();
  });
});
