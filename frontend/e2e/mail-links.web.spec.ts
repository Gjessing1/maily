/**
 * Links inside a message body must leave through the APP, not through the frame.
 *
 * The message frame is sandboxed without `allow-top-navigation`, so an anchor in it can
 * never navigate on its own — and the Android WebView creates no popup window either,
 * which is why mail links did nothing in the app at all. MailBody therefore listens for
 * clicks on the frame's document from the app side (ui/mailLink). jsdom models neither
 * the sandbox nor srcdoc, so this contract is only observable in a real engine.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RenderingFixtureOptions } from '../src/rendering-fixtures.js';

const LINKS_HTML = `
  <p><a id="web" href="https://selfh.st/newsletter/2026-08/">Read the newsletter</a></p>
  <p><a id="deep" href="https://example.com/deep"><span><b>nested target</b></span></a></p>
  <p><a id="evil" href="javascript:window.parent.__ran = true">Do not run</a></p>
  <p><a id="jump" href="#bottom">Jump down</a></p>
  <h2 id="bottom" style="margin-top:1200px">Bottom</h2>
`;

/** Record what the app document is asked to open instead of really opening it. */
async function trapWindowOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = (url) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    };
  });
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

async function render(
  page: Page,
  html: string,
  options: Omit<RenderingFixtureOptions, 'html' | 'label'> = { theme: 'light' },
): Promise<void> {
  await page.evaluate(
    ({ body, renderOptions }) =>
      window.renderMailFixture({ html: body, label: 'links', ...renderOptions }),
    { body: html, renderOptions: options },
  );
}

test.describe('message body links', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/rendering-fixtures/');
    await trapWindowOpen(page);
    await render(page, LINKS_HTML);
    await page.frameLocator('iframe[title="message"]').locator('#web').waitFor();
  });

  test('a web link is opened by the app, and the frame stays put', async ({ page }) => {
    const frame = page.frameLocator('iframe[title="message"]');
    await frame.locator('#web').click();

    // A popup made by the frame's own `target=_blank` would never reach window.open
    // here, so this is proof that the app's interception ran.
    expect(await opened(page)).toEqual(['https://selfh.st/newsletter/2026-08/']);
    expect(page.url()).toContain('/rendering-fixtures');
    const frameUrl = await page.evaluate(
      () =>
        (document.querySelector('iframe[title="message"]') as HTMLIFrameElement).contentWindow!
          .location.href,
    );
    expect(frameUrl).toBe('about:srcdoc');
  });

  test('a click on nested markup still resolves to its anchor', async ({ page }) => {
    await page.frameLocator('iframe[title="message"]').locator('#deep b').click();
    expect(await opened(page)).toEqual(['https://example.com/deep']);
  });

  test('a javascript: link neither runs nor opens anything', async ({ page }) => {
    await page.frameLocator('iframe[title="message"]').locator('#evil').click();
    expect(
      await page.evaluate(() => (window as unknown as { __ran?: true }).__ran),
    ).toBeUndefined();
    expect(await opened(page)).toEqual([]);
  });

  test('an in-document jump is left to the frame', async ({ page }) => {
    await page.frameLocator('iframe[title="message"]').locator('#jump').click();
    expect(await opened(page)).toEqual([]);
  });
});
