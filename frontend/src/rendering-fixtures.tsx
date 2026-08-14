/**
 * Test-only entry point for real-browser mail rendering checks. Vite serves this
 * page in development; it is not referenced by the production app entry or PWA.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MailHtml } from './components/MailBody';
import { setPref, type Theme } from './state/prefs';
import './index.css';

export interface RenderingFixtureOptions {
  html: string;
  allowImages?: boolean;
  theme?: Exclude<Theme, 'system'>;
  label: string;
}

declare global {
  interface Window {
    renderMailFixture: (options: RenderingFixtureOptions) => void;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('rendering fixture root is missing');
const root = createRoot(rootElement);

window.renderMailFixture = ({ html, allowImages = false, theme = 'light', label }) => {
  setPref('theme', theme);
  document.documentElement.dataset.theme = theme;
  document.title = `maily rendering fixture: ${label}`;
  flushSync(() => {
    root.render(
      <main data-testid="fixture" data-label={label} className="min-h-screen bg-bg text-fg">
        <MailHtml html={html} allowImages={allowImages} />
      </main>,
    );
  });
};
