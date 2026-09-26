import './polyfill';
import { createMarkdownContent } from 'defuddle/full';

/** Convert an HTML fragment (e.g. an HN comment) to Markdown with Defuddle's converter. */
export function htmlFragmentToMarkdown(html: string, url = 'https://anymd.cc/'): string {
  try {
    return createMarkdownContent(html, url).trim();
  } catch {
    return html.replace(/<[^>]+>/g, '').trim();
  }
}
