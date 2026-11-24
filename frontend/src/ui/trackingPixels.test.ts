/**
 * Tracking-pixel detection. The positive cases are shapes taken from real mail
 * (HubSpot, SendGrid, Brevo, Mailchimp); the negatives are the false positives the
 * rules must not hit, notably selfh.st's hidden-but-real thumbnails.
 */
import { describe, expect, test } from 'vitest';
import { isTrackingPixel, removeTrackingPixels } from './trackingPixels';

function img(html: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = doc.querySelector('img');
  if (!found) throw new Error('fixture has no <img>');
  return found;
}

describe('isTrackingPixel', () => {
  test("drops HubSpot's hidden 1×1 open pixel", () => {
    expect(
      isTrackingPixel(
        img(
          '<img src="https://d2v8tf04.eu1.hubspotlinks.com/Cto/W7+113/abc" alt="" width="1" height="1" border="0" style="display:none!important;min-height:1px!important;width:1px!important">',
        ),
      ),
    ).toBe(true);
  });

  test('drops a 1×1 declared by attributes or inline style', () => {
    expect(
      isTrackingPixel(img('<img src="https://url1.example.com/x.gif" width="1" height="1">')),
    ).toBe(true);
    expect(
      isTrackingPixel(img('<img src="https://t.example/o" style="width: 1px; height: 1px">')),
    ).toBe(true);
    expect(isTrackingPixel(img('<img src="//t.example/o" width="0" height="10">'))).toBe(true);
  });

  test('drops known open-tracking endpoints even without a size', () => {
    expect(
      isTrackingPixel(
        img('<img style="display:none" src="https://b5xn2.r.a.d.sendibm1.com/mk/op/sh/abc">'),
      ),
    ).toBe(true);
    expect(isTrackingPixel(img('<img src="https://url8.mail.example.com/wf/open?upn=abc">'))).toBe(
      true,
    );
    expect(
      isTrackingPixel(img('<img src="https://x.us3.list-manage.com/track/open.php?u=1">')),
    ).toBe(true);
  });

  test('keeps hidden real images that a media query reveals', () => {
    expect(
      isTrackingPixel(
        img(
          '<img src="https://selfh.st/content/images/thumbnail/elephant.png" alt style="border: none; max-width: 100%; display: none;">',
        ),
      ),
    ).toBe(false);
  });

  test('keeps content images, spacers taller than a pixel and non-remote images', () => {
    expect(
      isTrackingPixel(
        img(
          '<img alt="logo" src="https://hs-1.f.hubspotemail-eu1.net/hub/1/hubfs/logo.png" width="250">',
        ),
      ),
    ).toBe(false);
    expect(
      isTrackingPixel(img('<img src="https://cdn.example/pixel.gif" width="1" height="20">')),
    ).toBe(false);
    expect(
      isTrackingPixel(img('<img src="https://cdn.example/a.png" width="1%" height="1%">')),
    ).toBe(false);
    expect(
      isTrackingPixel(img('<img src="data:image/gif;base64,R0lGOD" width="1" height="1">')),
    ).toBe(false);
    expect(isTrackingPixel(img('<img src="cid:spacer" width="1" height="1">'))).toBe(false);
  });

  test('inline style size wins over the attribute', () => {
    expect(
      isTrackingPixel(
        img(
          '<img src="https://cdn.example/hero.png" width="1" height="1" style="width:600px;height:300px">',
        ),
      ),
    ).toBe(false);
  });
});

describe('removeTrackingPixels', () => {
  test('removes only the trackers', () => {
    const doc = new DOMParser().parseFromString(
      '<p>Hi<img src="https://cdn.example/hero.png" width="600"><img src="https://t.example/o" width="1" height="1"></p>',
      'text/html',
    );
    expect(removeTrackingPixels(doc.body)).toBe(1);
    expect(doc.body.innerHTML).toBe(
      '<p>Hi<img src="https://cdn.example/hero.png" width="600"></p>',
    );
  });
});
