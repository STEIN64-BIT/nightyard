import { describe, it, expect } from 'vitest';
import { deriveProjectName } from './project-name';

describe('deriveProjectName', () => {
  it('extracts the basename from POSIX paths', () => {
    expect(deriveProjectName('/Users/me/dev/nightyard')).toBe('nightyard');
  });

  it('extracts the basename from Windows paths', () => {
    expect(deriveProjectName('C:\\Users\\lauferism\\git\\nightyard')).toBe('nightyard');
  });

  it('strips trailing separators', () => {
    expect(deriveProjectName('/Users/me/dev/nightyard/')).toBe('nightyard');
    expect(deriveProjectName('C:\\Users\\me\\nightyard\\')).toBe('nightyard');
  });

  it('returns the fallback when cwd is empty', () => {
    expect(deriveProjectName('', 'my-slug')).toBe('my-slug');
  });

  it('returns the fallback when cwd has no basename', () => {
    expect(deriveProjectName('/', 'my-slug')).toBe('my-slug');
  });

  it('defaults to an empty string when no fallback is supplied', () => {
    expect(deriveProjectName('')).toBe('');
    expect(deriveProjectName('/')).toBe('');
  });
});
