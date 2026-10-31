import { vi } from 'vitest';

// sidebar.ts (and its import chain, e.g. modal.ts) reads `document.getElementById`
// at module load. The test environment is `node`, so we stub a minimal `document`
// before importing — mirroring the existing pattern in share-dialog.test.ts.
function stubElement(): Record<string, unknown> {
  return {
    className: '',
    style: { display: '', width: '' },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
    querySelector() { return null; },
  };
}
vi.stubGlobal('document', {
  getElementById() { return stubElement(); },
  createElement() { return stubElement(); },
  addEventListener() {},
  body: { appendChild() {} },
});

const { dotClassForStatus } = await import('./sidebar.js');

describe('dotClassForStatus', () => {
  it('maps working to pulsing class', () => { expect(dotClassForStatus('working')).toBe('vy-dot vy-dot--working'); });
  it('maps attention to amber class', () => { expect(dotClassForStatus('attention')).toBe('vy-dot vy-dot--attention'); });
  it('maps idle to hidden/dim class', () => { expect(dotClassForStatus('idle')).toBe('vy-dot vy-dot--idle'); });
});
