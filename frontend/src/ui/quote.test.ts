/**
 * Quote-history detection. The cases here are shapes taken from real mail in the
 * "Re: Tilbud 908094" thread — a Gmail `blockquote.gmail_quote`, an Outlook
 * `border-top` "Fra:" divider, and a plain-text `>` chain escaped into HTML (what
 * our own replies produce) — plus the false-positive guards.
 */
import { describe, expect, test } from 'vitest';
import { splitQuotedHtml, splitQuotedText } from './quote';

describe('splitQuotedText', () => {
  test('cuts at the attribution line and keeps the reply', () => {
    const { visible, quoted } = splitQuotedText(
      'Så Tore er på ferie så kanskje dere kan hjelpe meg.\n\n' +
        'On Wed, May 20, 2026, 16:50, Gjessing.io wrote:\n' +
        '> Lars Gjessing, Slyngveien 27, 1385 Asker.\n> \n> Takk!\n> \n> Med vennlig hilsen',
    );
    expect(visible).toBe('Så Tore er på ferie så kanskje dere kan hjelpe meg.');
    expect(quoted.startsWith('On Wed, May 20, 2026')).toBe(true);
    expect(quoted).toContain('Slyngveien 27');
  });

  test('cuts at a run of > lines with no attribution', () => {
    const { visible, quoted } = splitQuotedText(
      'Kort svar her.\n\n> første linje av sitatet\n> andre linje\n> tredje linje\n> fjerde',
    );
    expect(visible).toBe('Kort svar her.');
    expect(quoted).toContain('fjerde');
  });

  test('leaves a body with no quote alone', () => {
    const text = 'Hei,\n\nVedlagt er ditt tilbud som er gyldig i 30 dager.\n\nMvh';
    expect(splitQuotedText(text)).toEqual({ visible: text, quoted: '' });
  });

  test('does not split when there would be nothing left to show', () => {
    const text = 'On Mon, May 4, 2026, Tore wrote:\n> hele meldingen er bare et sitat her\n> mer';
    expect(splitQuotedText(text).quoted).toBe('');
  });

  test('does not split off a one-line quote (chip would cost more than it hides)', () => {
    const text = 'Svar.\n\nOn Mon, Tore wrote:\n> ok';
    expect(splitQuotedText(text).quoted).toBe('');
  });

  test('prose that merely ends in "wrote:" mid-sentence is not an attribution', () => {
    const text = 'Jeg leste boken han wrote: den var lang og ganske detaljert i beskrivelsene.';
    expect(splitQuotedText(text).quoted).toBe('');
  });
});

describe('splitQuotedHtml', () => {
  test('splits at a Gmail blockquote', () => {
    const { visible, quoted } = splitQuotedHtml(
      '<div dir="auto">Takk for det!</div><br>' +
        '<div class="gmail_quote"><div class="gmail_attr">On Mon, May 11, 2026 Tore wrote:</div>' +
        '<blockquote class="gmail_quote" style="border-left:1px #ccc solid">' +
        '<div>Hei, jeg bruker selv breitler siktet og er veldig fornøyd på di avstandene.</div>' +
        '</blockquote></div>',
    );
    expect(visible).toContain('Takk for det!');
    expect(visible).not.toContain('breitler');
    expect(quoted).toContain('breitler');
  });

  test('splits at an Outlook border-top "Fra:" divider, keeping the signature visible', () => {
    const { visible, quoted } = splitQuotedHtml(
      '<p class="MsoNormal">Supert, sender du meg adresse og tlf nr?</p>' +
        '<p class="MsoNormal">Vennlig hilsen Tore Harry Halvorsen</p>' +
        '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">' +
        '<p><b>Fra:</b> Lars Gjessing &lt;lars@gjessing.io&gt;<br><b>Sendt:</b> onsdag 20. mai 2026</p>' +
        '</div>' +
        '<p class="MsoNormal">Da ønsker jeg å bestille t3x med justerbar kolbe.</p>',
    );
    expect(visible).toContain('Vennlig hilsen');
    expect(visible).not.toContain('Fra:');
    expect(quoted).toContain('Fra:');
    // Content after the divider is history too, not just the header block.
    expect(quoted).toContain('justerbar kolbe');
  });

  test('splits a plain-text reply escaped into HTML (our own reply format)', () => {
    const { visible, quoted } = splitQuotedHtml(
      '<div>Så Tore er på ferie så kanskje dere kan hjelpe meg.</div><div><br></div>' +
        '<div>Hvordan er leveringstid om dagen?</div>' +
        '<div><br><br>On Wed, May 20, 2026, 16:50, Gjessing.io wrote:<br>' +
        '&gt; Lars Gjessing, Slyngveien 27, 1385 Asker. - 94428232<br>&gt; <br>' +
        '&gt; Takk! <br>&gt; <br>&gt; Med vennlig hilsen<br>&gt; Lars Gjessing</div>',
    );
    expect(visible).toContain('leveringstid');
    expect(visible).not.toContain('Slyngveien');
    expect(quoted).toContain('Gjessing.io wrote:');
    expect(quoted).toContain('Slyngveien');
  });

  test('a first message with no history is returned untouched', () => {
    const html = '<div><p>Hei,</p><p>Vedlagt er ditt tilbud som er gyldig i 30 dager.</p></div>';
    expect(splitQuotedHtml(html)).toEqual({ visible: html, quoted: '' });
  });

  test('a body that is only a quote stays fully visible', () => {
    const html =
      '<div class="gmail_quote"><blockquote>Hele meldingen er sitat og ingenting mer her.</blockquote></div>';
    expect(splitQuotedHtml(html).quoted).toBe('');
  });
});
