import { describe, expect, it } from 'vitest';
import { replaceLineWithBlock } from './RichTextEditor';

/**
 * The markdown-heading fix replaced `execCommand('formatBlock')` (a no-op on iOS
 * WebKit) with manual DOM. `replaceLineWithBlock` is that primitive — exercise the
 * line shapes the editor actually produces: a `<div>` line with text, an empty
 * `<div><br></div>` placeholder, and a bare text-node line.
 */
describe('replaceLineWithBlock', () => {
  it('rewrites a block line as the target tag, keeping its text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div>Hello</div>';
    const el = replaceLineWithBlock(root.firstChild as ChildNode, 'h1');
    expect(el.tagName).toBe('H1');
    expect(root.innerHTML).toBe('<h1>Hello</h1>');
  });

  it('seeds an empty line (lone <br>) with a ZWSP so the caret can land', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div><br></div>';
    const el = replaceLineWithBlock(root.firstChild as ChildNode, 'h2');
    expect(el.tagName).toBe('H2');
    expect(el.textContent).toBe('​');
    expect(el.querySelector('br')).toBeNull();
  });

  it('wraps a bare text-node line', () => {
    const root = document.createElement('div');
    root.appendChild(document.createTextNode('jot'));
    const el = replaceLineWithBlock(root.firstChild as ChildNode, 'h3');
    expect(el.tagName).toBe('H3');
    expect(root.innerHTML).toBe('<h3>jot</h3>');
  });

  it('carries inline formatting across', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div>a <strong>b</strong></div>';
    const el = replaceLineWithBlock(root.firstChild as ChildNode, 'blockquote');
    expect(el.tagName).toBe('BLOCKQUOTE');
    expect(root.innerHTML).toBe('<blockquote>a <strong>b</strong></blockquote>');
  });
});
