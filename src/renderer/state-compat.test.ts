import type { PersistedState } from '../shared/types';
import fixture from '../../tests/fixtures/state-pre-feature.json';

describe('backward compatibility', () => {
  it('loads pre-feature state without globalOverview', () => {
    const state = fixture as unknown as PersistedState;
    expect(state.globalOverview).toBeUndefined();
    expect(state.projects[0].name).toBe('Demo');
  });
});
