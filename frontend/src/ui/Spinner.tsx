export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block size-5 animate-spin rounded-full border-2 border-faint border-t-transparent ${className}`}
      role="status"
      aria-label="loading"
    />
  );
}
