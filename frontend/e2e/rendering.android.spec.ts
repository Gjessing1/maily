import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  _android,
  type AndroidDevice,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { deriveBodyFromSource } from '../../backend/src/imap/source-parse.js';
import type { RenderingFixtureOptions } from '../src/rendering-fixtures.js';

const FIXTURE_ORIGIN = 'http://10.0.2.2:4173';

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../backend/src/imap/fixtures/rendering/${name}.eml`, import.meta.url));

async function fixtureHtml(name: string): Promise<string> {
  const body = await deriveBodyFromSource(fixturePath(name));
  if (!body.bodyHtml) throw new Error(`${name}.eml did not resolve to an HTML display body`);
  return body.bodyHtml;
}

let device: AndroidDevice;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;

async function setViewport(width: number, height: number, mobile: boolean): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
}

async function chromiumScreenshot(): Promise<Buffer> {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return Buffer.from(data, 'base64');
}

async function render(
  name: string,
  options: Omit<RenderingFixtureOptions, 'html' | 'label'> = {},
): Promise<void> {
  const html = await fixtureHtml(name);
  await page.evaluate(
    ({ fixture, renderOptions }) =>
      window.renderMailFixture({ html: fixture, label: name, ...renderOptions }),
    { fixture: html, renderOptions: options },
  );
  const frame = page.locator('iframe[title="message"]');
  await expect(frame).toHaveCount(1);
  await expect.poll(() => frame.getAttribute('style')).toContain('height:');
}

async function messageFrame() {
  const iframe = await page.locator('iframe[title="message"]').elementHandle();
  const frame = await iframe?.contentFrame();
  if (!frame) throw new Error('message iframe did not become available');
  return frame;
}

test.describe('Gmail rendering fixtures on Android Chromium', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const devices = await _android.devices();
    if (devices.length === 0) {
      throw new Error('No booted Android emulator/device found; start an AVD before this suite');
    }
    device = devices[0];
    await device.shell('am force-stop com.android.chrome');
    context = await device.launchBrowser({ pkg: 'com.android.chrome' });
    page = context.pages()[0] ?? (await context.newPage());
    cdp = await context.newCDPSession(page);
    await setViewport(390, 844, true);
    await page.goto(`${FIXTURE_ORIGIN}/rendering-fixtures/`);
    await page.waitForFunction(() => typeof window.renderMailFixture === 'function');
    // Android Chrome can replace the initial renderer once after attaching the
    // DevTools viewport override. Let that settle before tests hold frame handles.
    await page.waitForTimeout(500);
    await page.waitForFunction(() => typeof window.renderMailFixture === 'function');
  });

  test.afterAll(async () => {
    await context?.close();
    await device?.close();
  });

  test.beforeEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await setViewport(390, 844, true);
    await page.waitForFunction(() => typeof window.renderMailFixture === 'function');
  });

  test('renders the MIME-selected winner and omits hidden/forwarded alternatives', async () => {
    const body = await deriveBodyFromSource(
      fileURLToPath(
        new URL('../../backend/src/imap/fixtures/gmail-rendering.eml', import.meta.url),
      ),
    );
    expect(body.bodyHtml).toContain('Visible HTML winner.');
    expect(body.bodyHtml).not.toContain('Stale HTML alternative.');
    expect(body.bodyHtml).not.toContain('Forwarded body must not render.');

    await page.evaluate(({ html }) => window.renderMailFixture({ html, label: 'mime-selection' }), {
      html: body.bodyHtml,
    });
    const frame = await messageFrame();
    await expect(frame.locator('body')).toContainText('Visible HTML winner.');
    await expect
      .poll(() => frame.locator('body').evaluate((body) => (body as HTMLElement).innerText))
      .not.toContain('Hidden preview trap');
    expect(await chromiumScreenshot()).toMatchSnapshot('phone-mime-selection.png');
  });

  test('zooms a fixed-width newsletter only at phone width', async () => {
    await render('fixed-width-newsletter');
    let frame = await messageFrame();
    const phoneGeometry = await frame.locator('body').evaluate((body) => ({
      transform: getComputedStyle(body).transform,
      width: body.getBoundingClientRect().width,
      viewport: document.documentElement.clientWidth,
    }));
    expect(phoneGeometry.transform).not.toBe('none');
    expect(phoneGeometry.width).toBeLessThanOrEqual(phoneGeometry.viewport + 1);
    expect(await chromiumScreenshot()).toMatchSnapshot('phone-fixed-newsletter.png');

    await setViewport(1024, 768, false);
    frame = await messageFrame();
    await expect
      .poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).transform))
      .toBe('none');
    expect(await chromiumScreenshot()).toMatchSnapshot('desktop-fixed-newsletter.png');
  });

  test('contains one wide pre, URL and table cell without shrinking prose', async () => {
    await render('isolated-overflow');
    const frame = await messageFrame();
    const geometry = await frame.locator('body').evaluate((body) => {
      const doc = body.ownerDocument;
      const pre = doc.querySelector('pre');
      const url = doc.querySelector('[data-case="url"]');
      const cell = doc.querySelector('[data-case="cell"]');
      return {
        bodyTransform: getComputedStyle(body).transform,
        preWrap: pre ? getComputedStyle(pre).overflowWrap : '',
        urlWrap: url ? getComputedStyle(url).overflowWrap : '',
        cellWrap: cell ? getComputedStyle(cell).overflowWrap : '',
        scrollWidth: doc.documentElement.scrollWidth,
        viewport: doc.documentElement.clientWidth,
      };
    });
    expect(geometry.bodyTransform).toBe('none');
    expect(geometry.preWrap).toBe('anywhere');
    // Conservative break-word already contains URLs in Chromium; the mutation
    // pass upgrades only tokens that still report overflow to `anywhere`.
    expect(['break-word', 'anywhere']).toContain(geometry.urlWrap);
    expect(geometry.cellWrap).toBe('anywhere');
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(await chromiumScreenshot()).toMatchSnapshot('phone-isolated-overflow.png');
  });

  test('remeasures when a delayed local image changes layout', async () => {
    let releaseImage!: () => void;
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.route('**/rendering-fixtures/delayed.svg', async (route) => {
      await imageGate;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480"><rect width="320" height="480" fill="#6d6bff"/><text x="24" y="60" fill="white" font-size="24">Delayed local image</text></svg>',
      });
    });
    await render('delayed-image', { allowImages: true });
    const iframe = page.locator('iframe[title="message"]');
    const frame = await messageFrame();
    const before = await iframe.evaluate((element) => element.getBoundingClientRect().height);
    await frame.locator('img').evaluate((image) => {
      const source = image.getAttribute('data-delayed-src');
      if (source) image.setAttribute('src', source);
    });
    releaseImage();
    await expect
      .poll(() =>
        frame
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalHeight),
      )
      .toBe(480);
    await expect
      .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(before + 300);
    expect(await chromiumScreenshot()).toMatchSnapshot('phone-delayed-image.png');
  });

  test('uses dark defaults but keeps sender-authored colours on a light sheet', async () => {
    await render('dark-unstyled', { theme: 'dark' });
    let frame = await messageFrame();
    await expect
      .poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
      .toBe('rgb(21, 21, 28)');
    expect(await chromiumScreenshot()).toMatchSnapshot('phone-dark-unstyled.png');

    await render('dark-authored', { theme: 'dark' });
    frame = await messageFrame();
    await expect
      .poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
      .toBe('rgb(255, 255, 255)');
  });

  test('blocks remote media and fonts before any sender request is made', async () => {
    const requested: string[] = [];
    await page.route('https://sender.invalid/**', async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await route.abort('blockedbyclient');
    });

    await render('remote-resources', { allowImages: false });
    await page.waitForTimeout(300);
    expect(requested).toEqual([]);

    await render('remote-resources', { allowImages: true });
    await expect.poll(() => requested).toContain('/tracking.png');
    expect(requested).not.toContain('/sender-font.woff2');
    expect(requested).not.toContain('/remote.css');
  });
});
