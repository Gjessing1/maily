/**
 * Re-measuring the message frame must not throw away the reader's scroll position.
 *
 * MailBody sizes the frame to its content, and to measure it it collapses the frame to
 * `height:0` for the length of one synchronous block. That briefly removes the whole
 * message from the page, so every scrolling ancestor's content shrinks and the browser
 * clamps its scroll offset to the new, much smaller maximum — putting the height back
 * does not put the offset back.
 *
 * Measurement is not a one-off: late image `load`/`error` events, `fonts.ready` and the
 * body ResizeObserver all re-fire it, and they cluster in the first second after a
 * message opens. That is the reported bug — the first swipe on a freshly opened message
 * sometimes refuses to scroll and the message just nudges, while later swipes are fine.
 *
 * jsdom performs no layout, so neither the clamp nor the fix is observable there; this
 * needs a real engine.
 */
import { expect, test, type Page } from '@playwright/test';

/** Tall enough that both the window and a short container are comfortably scrollable. */
const TALL_HTML = `
  <h1 id="top">Scroll test</h1>
  ${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1} — the quick brown fox jumps over the lazy dog.</p>`).join('\n')}
  <p id="end">End of message</p>
`;

/** Fire the exact path a late image settle or `fonts.ready` takes into `measure()`. */
async function forceRemeasure(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  // Measurement is queued on rAF; two frames is comfortably past it.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

test.describe('message frame re-measure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/rendering-fixtures/');
    await page.evaluate((html) => window.renderMailFixture({ html, label: 'scroll' }), TALL_HTML);
    await page.frameLocator('iframe[title="message"]').locator('#end').waitFor();
    // Let the burst of initial measurements settle before taking a baseline.
    await forceRemeasure(page);
  });

  test('keeps the page scroll position across a re-measure', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 400));
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(400);

    await forceRemeasure(page);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(400);

    // The real case is a burst of them, not one.
    for (let i = 0; i < 3; i++) await forceRemeasure(page);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(400);
  });

  test('keeps a scrolling container position across a re-measure', async ({ page }) => {
    // The reader scrolls an `overflow-y-auto` container rather than the document, so
    // the ancestor walk — not the window fallback — is what has to hold there.
    await page.evaluate(() => {
      const container = document.querySelector('main');
      if (!container) throw new Error('fixture container is missing');
      container.style.height = '400px';
      container.style.overflowY = 'auto';
    });
    await forceRemeasure(page);

    const scrollTop = () =>
      page.evaluate(() => Math.round(document.querySelector('main')!.scrollTop));

    await page.evaluate(() => {
      document.querySelector('main')!.scrollTop = 300;
    });
    expect(await scrollTop()).toBe(300);

    await forceRemeasure(page);
    expect(await scrollTop()).toBe(300);
  });
});
