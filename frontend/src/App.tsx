import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/auth';
import { useSignals } from './state/signals';
import { SyncBar } from './components/SyncBar';
import { Login } from './routes/Login';
import { Home } from './routes/Home';
import { Reader } from './routes/Reader';
import { Compose } from './routes/Compose';
import { Search } from './routes/Search';
import { Settings } from './routes/Settings';

export function App() {
  const { authed } = useAuth();

  // Signal handling must live above the routes so flag/new-mail updates land in
  // the cache regardless of which screen is mounted.
  const { progress } = useSignals();

  if (!authed) return <Login />;

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50">
        <SyncBar progress={progress} />
      </div>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/m/:id" element={<Reader />} />
        <Route path="/compose" element={<Compose />} />
        <Route path="/search" element={<Search />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
