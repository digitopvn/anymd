import { describe, expect, it } from 'vitest';
import type { DocumentSummary } from '../src/library/store';
import { LibraryPage } from '../src/views/dashboard';

const doc = { id: 'doc_1', url: 'https://example.com', title: 'Example', domain: 'example.com', source_kind: 'web', tags: 'ai rag', word_count: 10, created_at: 1 } as DocumentSummary;

describe('library page tag filter', () => {
  it('renders tag chips that link to ?tag= and marks the active one', () => {
    const html = String(<LibraryPage docs={[doc]} domains={[]} kinds={[]} tags={[{ tag: 'ai', count: 2 }, { tag: 'rag', count: 1 }]} filter={{ tag: 'ai' }} nextCursor={null} total={2} />);
    expect(html.includes('href="/dashboard/library?tag=rag"')).toBe(true);
    // The active chip toggles the filter off and is announced as current.
    expect(/<a href="\/dashboard\/library"[^>]*aria-current="true"[^>]*>#ai · 2/.test(html)).toBe(true);
    expect(html.includes('aria-label="Filter by tag"')).toBe(true);
  });

  it('shows a tag-specific empty state', () => {
    const html = String(<LibraryPage docs={[]} domains={[]} kinds={[]} tags={[]} filter={{ tag: 'zzz' }} nextCursor={null} total={0} />);
    expect(html.includes('No documents with this tag')).toBe(true);
    expect(html.includes('#zzz')).toBe(true);
  });
});
