import { useState, type FormEvent } from 'react';
import { useAuth } from '../state/auth';
import { Spinner } from '../ui/Spinner';
import { MailOpenIcon } from '../ui/icons';

export function Login() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch {
      setError('Incorrect password.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="safe-top safe-bottom flex min-h-full flex-col items-center justify-center px-6">
      <div className="mb-8 flex flex-col items-center gap-3">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <MailOpenIcon width={32} height={32} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">maily</h1>
        <p className="text-sm text-muted">Sign in with your master password.</p>
      </div>

      <form onSubmit={onSubmit} className="flex w-full max-w-xs flex-col gap-3">
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          inputMode="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Master password"
          className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base outline-none focus:border-accent"
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 font-medium text-white transition active:scale-[0.98] disabled:opacity-40"
        >
          {busy ? <Spinner className="border-white/70" /> : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
