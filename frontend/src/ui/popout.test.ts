import { beforeEach, describe, expect, it } from 'vitest';
import { putHandoff, sweepHandoffs, takeHandoff } from './popout';

describe('popout compose hand-off', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a prefill and consumes it exactly once', () => {
    const id = putHandoff({ to: ['a@example.com'], subject: 'Re: hi' });
    expect(id).toBeTruthy();

    expect(takeHandoff<{ subject: string }>(id)).toEqual({
      to: ['a@example.com'],
      subject: 'Re: hi',
    });
    // A reload of the popout must not resurrect it — history state owns the prefill by then.
    expect(takeHandoff(id)).toBeNull();
  });

  it('returns null for a missing or absent id', () => {
    expect(takeHandoff(null)).toBeNull();
    expect(takeHandoff('nope')).toBeNull();
  });

  it('sweeps stale hand-offs but spares one another tab just parked', () => {
    const fresh = putHandoff({ subject: 'in flight' })!;
    const stale = putHandoff({ subject: 'window never opened' })!;
    // Backdate the stale record past the sweep window.
    const key = `maily.popout.handoff.${stale}`;
    const rec = JSON.parse(localStorage.getItem(key)!) as { at: number };
    rec.at = Date.now() - 10 * 60_000;
    localStorage.setItem(key, JSON.stringify(rec));

    sweepHandoffs();

    expect(takeHandoff(stale)).toBeNull();
    expect(takeHandoff<{ subject: string }>(fresh)).toEqual({ subject: 'in flight' });
  });
});
