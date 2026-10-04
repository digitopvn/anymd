# Simplification Review — Social Conversion

## Scope and verification

Read-only review of the pending conversion work, centered on:

- `src/convert/social-common.ts`
- `src/convert/provider-fetch.ts`
- `src/convert/enrichment-types.ts`
- `src/convert/image-enrichment.ts`
- `src/convert/x-thread.ts`
- `src/convert/facebook.ts`
- `src/convert/instagram.ts`
- `src/convert/threads.ts`
- `src/convert/linkedin.ts`

The review preserved the accepted full scope: bounded credit accounting, partial enrichment sections, verified provider response shapes, complete rooted same-author X threads, and nested comments. No source files were changed.

Validation run on the reviewed tree:

- `npx vitest run test/enrichment.test.ts`: 24/24 passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

## Findings

### Low — The plaintext escaper still permits some Markdown block syntax

`plainMarkdown` in `src/convert/social-common.ts:11` escapes images, headings, HTML delimiters, emphasis, and several other control characters, but it leaves `-`, `+`, `.`, and `~` unchanged. Provider text such as `- item`, `1. item`, `---`, or `~~text~~` can therefore still become a list, rule, or strikethrough. The same helper feeds post captions and quoted comment author/text values, so this is observable in both base social content and comment enrichment.

This does not recreate the paid-image-fetch defect: brackets and exclamation marks are escaped, and `articleImages` therefore cannot recognize an injected image from those fields. It does mean the helper's intended plaintext contract is incomplete.

Recommendation: extend the escaping behavior with focused tests for unordered lists, ordered lists, thematic rules, and strikethrough. Prefer a small line-aware rule for block markers if preserving ordinary punctuation matters; otherwise extend the existing explicit character class. Keep provider-verified media links as the only active Markdown added by `socialResult`.

### Low — `x-thread.ts` duplicates the shared unknown-value parsing helpers

`src/convert/x-thread.ts:17-19` defines local `RecordData`, `record`, and `str` helpers that are behaviorally identical to `Data`, `object`, and `string` in `src/convert/social-common.ts:5-7`. The module already imports `quote` from `social-common`, so reusing the existing helpers would remove duplicate parsing policy without introducing a new abstraction.

Recommendation: import `object` and `string` alongside `quote`, remove the local aliases, and retain `parseTweet` exactly as-is otherwise. This is a mechanical cleanup; it should not be mixed with changes to accepted provider shapes or relationship validation.

## Complexity that should remain

- Keep the Facebook, Instagram, Threads, and LinkedIn pagination loops provider-specific. Their queue entries, pagination evidence, nested-reply discovery, and completeness rules differ materially. A generic paginator would hide the source-specific invariants without reducing real complexity.
- Keep the fixed-point passes in `threadMembers` and X comment reachability. They allow children to appear before parents in provider results while enforcing rooted relationships; replacing them with a one-pass filter would break full same-author threads or nested comments.
- Keep charging adjacent to acceptance/rendering rather than provider fetches. The current placement preserves the stated contract that only successfully returned units consume the caller's credit budget and retains earlier partial sections after later failures.
- Keep `readBounded` shared between provider JSON and image/model responses. It is a small boundary helper with two distinct size caps and prevents response buffering from bypassing limits.

## Conclusion

No blocking simplification issue was found. The current module boundaries are proportionate to the provider differences, and the main behavior is covered by focused tests. Address the plaintext escaping gap before calling the trust boundary fully closed; the helper deduplication can be applied opportunistically.

Status: DONE_WITH_CONCERNS

Summary: No broad rewrite is warranted. One low-severity plaintext Markdown gap and one mechanical helper duplication remain.

Concerns/Blockers: Provider live availability remains external evidence; no local blocker was found.
