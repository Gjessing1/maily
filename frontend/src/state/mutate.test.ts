/**
 * A read/star change shows at once, is taken back if the server refuses it, and is not made at
 * all while offline (offline mail is read-only).
 */
import { beforeEach, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ setFlags: vi.fn() }));
const patchCachedFlags = vi.hoisted(() => vi.fn());
const showNotice = vi.hoisted(() => vi.fn());
const connected = vi.hoisted(() => ({ value: true }));
vi.mock('../api/client', () => ({ api }));
vi.mock('../db/cache', () => ({ patchCachedFlags }));
vi.mock('./undo', () => ({ showNotice }));
vi.mock('./connectivity', () => ({
  isConnected: () => connected.value,
  OFFLINE_READ_ONLY_MESSAGE: 'offline',
}));

import { mutateFlags } from './mutate';

beforeEach(() => {
  api.setFlags.mockReset();
  patchCachedFlags.mockReset();
  showNotice.mockReset();
  connected.value = true;
});

test('applies to every id at once and asks the server for each', () => {
  api.setFlags.mockResolvedValue({ ok: true });
  const onApply = vi.fn();
  expect(mutateFlags(['a', 'b'], { seen: true }, { onApply })).toBe(true);
  expect(patchCachedFlags.mock.calls).toEqual([
    ['a', { seen: true }],
    ['b', { seen: true }],
  ]);
  expect(onApply.mock.calls).toEqual([
    ['a', { seen: true }],
    ['b', { seen: true }],
  ]);
  expect(api.setFlags.mock.calls).toEqual([
    ['a', { seen: true }],
    ['b', { seen: true }],
  ]);
});

test('a refused request is reverted and reported', async () => {
  api.setFlags.mockRejectedValue(new Error('500'));
  const onApply = vi.fn();
  mutateFlags(['a'], { flagged: true }, { onApply });
  await vi.waitFor(() => expect(showNotice).toHaveBeenCalledWith('Couldn’t update — reverted'));
  expect(patchCachedFlags).toHaveBeenLastCalledWith('a', { flagged: false });
  expect(onApply).toHaveBeenLastCalledWith('a', { flagged: false });
});

test('quiet changes revert without a notice', async () => {
  api.setFlags.mockRejectedValue(new Error('500'));
  mutateFlags(['a'], { seen: true }, { quiet: true });
  await vi.waitFor(() => expect(patchCachedFlags).toHaveBeenLastCalledWith('a', { seen: false }));
  expect(showNotice).not.toHaveBeenCalled();
});

test('offline changes nothing and says why', () => {
  connected.value = false;
  expect(mutateFlags(['a'], { seen: true })).toBe(false);
  expect(patchCachedFlags).not.toHaveBeenCalled();
  expect(api.setFlags).not.toHaveBeenCalled();
  expect(showNotice).toHaveBeenCalledWith('offline');
});
