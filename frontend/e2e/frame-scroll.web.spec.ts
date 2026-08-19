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

/**
 * A scroll that lands on the message must move the reader behind it.
 *
 * The frame is sized to its content, so it has nothing of its own to scroll — but it is
 * still a document with a viewport, and what that viewport does with an unusable scroll
 * decides whether the gesture reaches the reader. `overscroll-behavior:none` on the
 * frame's `html` lands on the ROOT element and so propagates to the frame's viewport,
 * where it does not mean "don't stretch" but "never chain out of me": every scroll over
 * the message went nowhere, which is why the message read as unscrollable on the APK.
 * `overflow:hidden` removes the scroll port instead of refusing the chain, so the frame
 * is not a scroll target at all and the gesture lands on the reader.
 *
 * Measured against a standalone reproduction, exactly-sized frame then 2px short:
 *
 *   no rule                  reader 781 / 0     (0 = the sub-pixel latch this all started from)
 *   overscroll-behavior:none reader   0 / 0     (regressed the first case, never fixed the second)
 *   overflow:hidden          reader 781 / 779
 *
 * These drive input through the browser rather than assigning `scrollTop`: chaining is
 * decided by the compositor's hit test, which a scripted scroll skips entirely — which is
 * exactly why the two re-measure tests above pass with this bug present. Wheel, not touch:
 * the headless shell has no touch-scroll pipeline (a synthesized touch gesture moves
 * nothing even on a plain page), while wheel goes through the same chaining path and does
 * reproduce both the bug and the fix.
 */
test.describe('message frame scroll chaining', () => {
  /** Scroll `distance` px with the pointer over `selector`, then let it settle. */
  async function wheelOver(page: Page, selector: string, distance: number): Promise<void> {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`no box for ${selector}`);
    const viewport = page.viewportSize();
    // A point inside both the element and the viewport.
    const y = Math.max(
      box.y + 10,
      Math.min(box.y + box.height / 2, (viewport?.height ?? 800) - 100),
    );
    await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(y));
    await page.mouse.wheel(0, distance);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
    );
  }

  const readerScrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

  test.beforeEach(async ({ page }) => {
    await page.goto('/rendering-fixtures/');
    await page.evaluate((html) => window.renderMailFixture({ html, label: 'chaining' }), TALL_HTML);
    await page.frameLocator('iframe[title="message"]').locator('#end').waitFor();
    await forceRemeasure(page);
    // Sanity: the reader really has somewhere to scroll to, so a 0 below means the
    // gesture was swallowed rather than that there was no room for it.
    const room = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(room).toBeGreaterThan(300);
  });

  test('a scroll over the message moves the reader behind it', async ({ page }) => {
    expect(await readerScrollY(page)).toBe(0);
    await wheelOver(page, 'iframe[title="message"]', 400);
    expect(await readerScrollY(page)).toBeGreaterThan(0);
  });

  test('a frame left a fraction short still scrolls the reader', async ({ page }) => {
    // The case the original `overscroll-behavior` rule was aimed at: a measurement
    // remainder leaves the inner document a hair scrollable, and on Android the touch
    // latches into that hair and shows the overscroll stretch instead of scrolling the
    // reader. Nothing observes the iframe's own box, so shrinking it does not re-measure.
    const shortened = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="message"]');
      if (!iframe) throw new Error('message frame is missing');
      iframe.style.height = `${iframe.clientHeight - 2}px`;
      const el = iframe.contentDocument!.documentElement;
      return el.scrollHeight - el.clientHeight;
    });
    expect(shortened).toBeGreaterThan(0); // the frame really is short of its content

    await wheelOver(page, 'iframe[title="message"]', 400);
    expect(await readerScrollY(page)).toBeGreaterThan(0);
  });

  test('the message frame has no scroll port of its own to swallow the gesture', async ({
    page,
  }) => {
    // The other half of the contract: the frame must not be scrollable itself, or the
    // gesture legitimately belongs to it and the Android overscroll stretch comes back.
    const frame = await page.evaluate(() => {
      const doc =
        document.querySelector<HTMLIFrameElement>('iframe[title="message"]')?.contentDocument;
      if (!doc) throw new Error('message frame is missing');
      const el = doc.documentElement;
      return {
        overflowY: doc.defaultView!.getComputedStyle(el).overflowY,
        scrollable: el.scrollHeight - el.clientHeight,
      };
    });
    expect(frame.overflowY).toBe('hidden');
    expect(frame.scrollable).toBeLessThanOrEqual(1);
  });

  /**
   * `overflow:hidden` changes the failure mode of an under-measured frame: a message's
   * tail is now CLIPPED rather than left scrollable, so a height that comes up short eats
   * content silently instead of degrading visibly. Guard the measurement itself.
   *
   * The tail's own rect is the assertion that always holds. `scrollHeight` is only
   * comparable to the frame on the un-zoomed path: a fixed-width template gets
   * `transform: scale()` on the body, and the root still reports the pre-scale height
   * (a 600px template measured 637 against a correct 403px frame) with nothing actually
   * clipped. TALL_HTML reflows and never zooms, which the scale check below pins down.
   */
  test('the frame is tall enough to show the whole message', async ({ page }) => {
    const fit = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="message"]');
      const doc = iframe?.contentDocument;
      if (!iframe || !doc) throw new Error('message frame is missing');
      const end = doc.getElementById('end');
      if (!end) throw new Error('message tail is missing');
      return {
        frameHeight: iframe.clientHeight,
        contentHeight: doc.documentElement.scrollHeight,
        tailBottom: end.getBoundingClientRect().bottom,
        transform: doc.body.style.transform,
      };
    });
    expect(fit.transform).toBe(''); // precondition: no zoom-to-fit on this fixture
    // scrollHeight still reports clipped overflow, so this catches a short frame.
    expect(fit.contentHeight).toBeLessThanOrEqual(fit.frameHeight + 1);
    expect(fit.tailBottom).toBeLessThanOrEqual(fit.frameHeight + 1);
  });
});
