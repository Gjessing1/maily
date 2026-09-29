/**
 * Reader fact cards: shown only when there's something to show, values copied in the
 * form a bank app takes (account digits only, NOK amount with a decimal comma), and
 * Track opening the carrier's page through the shell.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MessageFactsDto } from '@maily/shared';

const openNativeExternal = vi.fn((_url: string) => Promise.resolve());
vi.mock('../nativeAndroid', () => ({ openNativeExternal: (u: string) => openNativeExternal(u) }));

const { FactCards, amountForCopy } = await import('./FactCards');

const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  openNativeExternal.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const facts: MessageFactsDto = {
  payment: {
    kids: ['110000637677425'],
    accounts: ['6021.07.45583'],
    ibans: [],
    amount: { value: 398, currency: 'NOK' },
    dueDate: '2026-10-02',
  },
  shipments: [
    {
      carrier: 'UPS',
      trackingNumber: '1ZE317X66892253506',
      trackingUrl: 'https://www.ups.com/track?tracknum=1ZE317X66892253506',
      estimatedDelivery: null,
    },
  ],
};

describe('FactCards', () => {
  test('renders nothing without facts', () => {
    const { container } = render(<FactCards facts={{ payment: null, shipments: [] }} />);
    expect(container.innerHTML).toBe('');
    const none = render(<FactCards facts={undefined} />);
    expect(none.container.innerHTML).toBe('');
  });

  test('copies the account as bare digits and the KID as printed', async () => {
    render(<FactCards facts={facts} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy Account/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('60210745583'));
    fireEvent.click(screen.getByRole('button', { name: /Copy KID/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('110000637677425'));
  });

  test('Track opens the carrier page through the shell', () => {
    render(<FactCards facts={facts} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track' }));
    expect(openNativeExternal).toHaveBeenCalledWith(facts.shipments[0]!.trackingUrl);
  });

  test('amounts copy without grouping, NOK with a decimal comma', () => {
    expect(amountForCopy({ value: 57819, currency: 'NOK' })).toBe('57819,00');
    expect(amountForCopy({ value: 12.5, currency: 'EUR' })).toBe('12.50');
  });
});
