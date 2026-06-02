import type { SyncProgress } from '../state/signals';

/** Thin top progress bar shown while a background sync streams in (§3 signals). */
export function SyncBar({ progress }: { progress: SyncProgress | null }) {
  if (!progress || progress.total <= 0) return null;
  const pct = Math.min(100, Math.round((progress.done / progress.total) * 100));
  return (
    <div className="h-0.5 w-full bg-transparent">
      <div
        className="h-full bg-accent transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
