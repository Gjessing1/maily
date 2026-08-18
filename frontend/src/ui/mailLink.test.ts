import { describe, expect, it, vi } from 'vitest';
import { classifyMailLink, createMailLinkClickHandler, parseMailto } from './mailLink';

describe('classifyMailLink', () => {
  it('routes web links out of the message', () => {
    expect(classifyMailLink('https://selfh.st/newsletter/2026-08/')).toEqual({
      kind: 'external',
      url: 'https://selfh.st/newsletter/2026-08/',
    });
    expect(classifyMailLink('http://example.com/x?y=1#z')).toEqual({
      kind: 'external',
      url: 'http://example.com/x?y=1#z',
    });
  });

  it('leaves an in-document jump to the frame', () => {
    // Inside an srcdoc frame the DOM resolves `#top` against the APP url, so only the
    // raw attribute can tell a fragment link from a link back into our own origin.
    expect(classifyMailLink('https://mail.example.com/m/abc#top', '#top')).toEqual({
      kind: 'fragment',
    });
  });

  it('hands dialer/SMS schemes to the platform', () => {
    expect(classifyMailLink('tel:+4512345678')).toEqual({
      kind: 'platform',
      url: 'tel:+4512345678',
    });
    expect(classifyMailLink('sms:+4512345678')).toEqual({
      kind: 'platform',
      url: 'sms:+4512345678',
    });
  });

  it('refuses schemes that could execute or smuggle content', () => {
    expect(classifyMailLink('javascript:alert(1)')).toEqual({ kind: 'blocked' });
    expect(classifyMailLink('data:text/html,<b>hi')).toEqual({ kind: 'blocked' });
    expect(classifyMailLink('blob:https://mail.example.com/1234')).toEqual({ kind: 'blocked' });
    expect(classifyMailLink('not a url')).toEqual({ kind: 'blocked' });
  });
});

describe('parseMailto', () => {
  it('splits recipients, subject and body', () => {
    expect(
      parseMailto('mailto:a@example.com,b@example.com?subject=Hi%20there&body=Line%201'),
    ).toEqual({
      kind: 'compose',
      to: ['a@example.com', 'b@example.com'],
      cc: [],
      subject: 'Hi there',
      body: 'Line 1',
    });
  });

  it('merges a ?to= list with the path and keeps cc', () => {
    expect(parseMailto('mailto:?to=a@example.com&cc=c@example.com,d@example.com')).toEqual({
      kind: 'compose',
      to: ['a@example.com'],
      cc: ['c@example.com', 'd@example.com'],
    });
  });

  it('drops bcc rather than disclosing it as a cc', () => {
    const link = parseMailto('mailto:a@example.com?bcc=secret@example.com');
    expect(link.cc).toEqual([]);
    expect(link.to).toEqual(['a@example.com']);
  });

  it('survives a malformed escape', () => {
    expect(parseMailto('mailto:a%zz@example.com')).toEqual({
      kind: 'compose',
      to: ['a%zz@example.com'],
      cc: [],
    });
  });
});

/** Minimal stand-in for the click the sandboxed frame dispatches. */
function clickOn(target: Element, overrides: Partial<MouseEvent> = {}) {
  const preventDefault = vi.fn();
  const event = {
    target,
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault,
    ...overrides,
  } as unknown as MouseEvent;
  return { event, preventDefault };
}

function anchor(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild!;
}

describe('createMailLinkClickHandler', () => {
  function handlers() {
    return {
      openExternal: vi.fn(),
      openCompose: vi.fn(),
      openPlatform: vi.fn(),
    };
  }

  it('cancels the frame navigation and opens a web link outside', () => {
    const spies = handlers();
    const link = anchor('<a href="https://example.com/x" target="_blank">read more</a>');
    const { event, preventDefault } = clickOn(link);
    createMailLinkClickHandler(spies)(event);
    expect(preventDefault).toHaveBeenCalled();
    expect(spies.openExternal).toHaveBeenCalledWith('https://example.com/x');
  });

  it('finds the anchor a click landed inside', () => {
    const spies = handlers();
    const link = anchor('<a href="https://example.com/x"><span><b>deep</b></span></a>');
    const inner = link.querySelector('b')!;
    createMailLinkClickHandler(spies)(clickOn(inner).event);
    expect(spies.openExternal).toHaveBeenCalledWith('https://example.com/x');
  });

  it('sends a mailto to the composer', () => {
    const spies = handlers();
    const link = anchor('<a href="mailto:sales@example.com?subject=Quote">contact</a>');
    createMailLinkClickHandler(spies)(clickOn(link).event);
    expect(spies.openCompose).toHaveBeenCalledWith({
      kind: 'compose',
      to: ['sales@example.com'],
      cc: [],
      subject: 'Quote',
    });
  });

  it('ignores clicks that are not on a link, and modified clicks', () => {
    const spies = handlers();
    const plain = anchor('<p>just text</p>');
    createMailLinkClickHandler(spies)(clickOn(plain).event);
    const link = anchor('<a href="https://example.com/x">x</a>');
    createMailLinkClickHandler(spies)(clickOn(link, { ctrlKey: true }).event);
    createMailLinkClickHandler(spies)(clickOn(link, { button: 1 }).event);
    expect(spies.openExternal).not.toHaveBeenCalled();
    expect(spies.openCompose).not.toHaveBeenCalled();
    expect(spies.openPlatform).not.toHaveBeenCalled();
  });

  it('swallows a javascript: link without routing it anywhere', () => {
    const spies = handlers();
    const link = anchor('<a href="javascript:alert(1)">click</a>');
    const { event, preventDefault } = clickOn(link);
    createMailLinkClickHandler(spies)(event);
    expect(preventDefault).toHaveBeenCalled();
    expect(spies.openExternal).not.toHaveBeenCalled();
    expect(spies.openPlatform).not.toHaveBeenCalled();
    expect(spies.openCompose).not.toHaveBeenCalled();
  });

  it('leaves an in-document jump to the frame itself', () => {
    const spies = handlers();
    const link = anchor('<a href="#section">skip</a>');
    const { event, preventDefault } = clickOn(link);
    createMailLinkClickHandler(spies)(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(spies.openExternal).not.toHaveBeenCalled();
  });
});
