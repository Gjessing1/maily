/**
 * Plain-text derivation from editor HTML. The blockquote cases matter most: a
 * reply quotes its history as a `blockquote.gmail_quote` (so receiving clients
 * draw the grey bar), and the `>` prefixes RFC 3676 expects have to be rebuilt
 * here for the text/plain alternative.
 */
import { describe, expect, test } from 'vitest';
import { htmlToPlainText, plainTextToHtml } from './htmlText';

describe('htmlToPlainText', () => {
  test('prefixes blockquote lines with >', () => {
    const text = htmlToPlainText(
      '<div>Ja, det stemmer.</div><div><br></div>' +
        '<div class="gmail_quote"><div class="gmail_attr">On Wed, May 20, Tore wrote:</div>' +
        '<blockquote class="gmail_quote" style="border-left:1px #ccc solid">' +
        '<div>Kan du bekrefte adressen?</div><div><br></div><div>Takk!</div>' +
        '</blockquote></div>',
    );
    // Blank line after the attribution, then the quote — the shape Gmail's own
    // text/plain part has.
    expect(text).toBe(
      'Ja, det stemmer.\n\nOn Wed, May 20, Tore wrote:\n\n> Kan du bekrefte adressen?\n>\n> Takk!',
    );
  });

  test('nests quote markers for a quoted quote', () => {
    const text = htmlToPlainText(
      '<blockquote><div>ytre</div><blockquote><div>indre</div></blockquote></blockquote>',
    );
    expect(text).toBe('> ytre\n>\n> > indre');
  });

  test('keeps lists and links legible', () => {
    expect(htmlToPlainText('<ul><li>en</li><li>to</li></ul>')).toBe('- en\n- to');
    expect(htmlToPlainText('<a href="https://x.test">x</a>')).toBe('x <https://x.test>');
  });
});

describe('plainTextToHtml', () => {
  test('escapes and breaks lines', () => {
    expect(plainTextToHtml('a < b\nc')).toBe('a &lt; b<br>c');
  });
});
