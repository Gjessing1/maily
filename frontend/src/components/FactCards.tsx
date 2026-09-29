/**
 * Passive fact cards above a message body: what the enrichers already extracted,
 * laid out for the moment it's needed — paying a bill (amount, due date, account,
 * KID, IBAN) or checking on a parcel (carrier, tracking number, the carrier's page).
 * Tap a value to copy it. Nothing here nags, counts down or collects into a list;
 * the card is just there when the message is open (the anti-chore stance).
 */
import { useEffect, useRef, useState } from 'react';
import type { MessageFactsDto, PaymentDetailsDto, ShipmentDto } from '@maily/shared';
import { CheckIcon, CopyIcon, PackageIcon, ReceiptIcon } from '../ui/icons';
import { openNativeExternal } from '../nativeAndroid';
import { showNotice } from '../state/undo';

/** Display an amount in its currency; an unknown code falls back to "12.50 XYZ". */
export function formatAmount(amount: { value: number; currency: string }): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: amount.currency,
    }).format(amount.value);
  } catch {
    return `${amount.value.toFixed(2)} ${amount.currency}`;
  }
}

/** The amount as a bank app's amount field takes it: no grouping, comma decimals for NOK. */
export function amountForCopy(amount: { value: number; currency: string }): string {
  const fixed = amount.value.toFixed(2);
  return amount.currency === 'NOK' ? fixed.replace('.', ',') : fixed;
}

/** A calendar date (YYYY-MM-DD) in the user's locale, without a timezone shift. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** One labelled value; tapping copies `copy` (defaults to the shown value). */
function CopyRow({ label, value, copy }: { label: string; value: string; copy?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copy ?? value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      showNotice('Couldn’t copy to the clipboard');
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={`Copy ${label}: ${value}`}
      className="flex w-full items-center gap-3 px-3 py-2 text-left active:bg-surface-2"
    >
      <span className="w-16 shrink-0 text-xs text-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm tabular-nums">{value}</span>
      {copied ? (
        <CheckIcon className="size-4 shrink-0 text-accent" />
      ) : (
        <CopyIcon className="size-4 shrink-0 text-faint" />
      )}
    </button>
  );
}

function PaymentCard({ payment }: { payment: PaymentDetailsDto }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <p className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-xs font-medium text-muted">
        <ReceiptIcon className="size-4" />
        Payment details
      </p>
      {payment.amount && (
        <CopyRow
          label="Amount"
          value={formatAmount(payment.amount)}
          copy={amountForCopy(payment.amount)}
        />
      )}
      {payment.dueDate && (
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="w-16 shrink-0 text-xs text-faint">Due</span>
          <span className="text-sm">{formatDay(payment.dueDate)}</span>
        </div>
      )}
      {payment.accounts.map((a) => (
        <CopyRow key={a} label="Account" value={a} copy={a.replace(/\D/g, '')} />
      ))}
      {payment.kids.map((k) => (
        <CopyRow key={k} label="KID" value={k} />
      ))}
      {payment.ibans.map((i) => (
        <CopyRow key={i} label="IBAN" value={i.replace(/(.{4})/g, '$1 ').trim()} copy={i} />
      ))}
    </section>
  );
}

function ShipmentCard({ shipment }: { shipment: ShipmentDto }) {
  const url = shipment.trackingUrl;
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <p className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted">
          <PackageIcon className="size-4 shrink-0" />
          <span className="truncate">Parcel · {shipment.carrier}</span>
        </p>
        {url && (
          <button
            type="button"
            onClick={() =>
              void openNativeExternal(url).catch(() => showNotice('Could not open that link'))
            }
            className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-accent active:bg-surface-3"
          >
            Track
          </button>
        )}
      </div>
      <CopyRow label="Tracking" value={shipment.trackingNumber} />
      {shipment.estimatedDelivery && (
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="w-16 shrink-0 text-xs text-faint">Expected</span>
          <span className="text-sm">{formatDay(shipment.estimatedDelivery.slice(0, 10))}</span>
        </div>
      )}
    </section>
  );
}

/** The cards for one message, or nothing when the enrichers found nothing usable. */
export function FactCards({ facts }: { facts: MessageFactsDto | undefined }) {
  if (!facts || (!facts.payment && facts.shipments.length === 0)) return null;
  return (
    <div className="space-y-2 px-4 pb-3">
      {facts.payment && <PaymentCard payment={facts.payment} />}
      {facts.shipments.map((s) => (
        <ShipmentCard key={`${s.carrier}:${s.trackingNumber}`} shipment={s} />
      ))}
    </div>
  );
}
