/** The ChatGPT plugin directory package stays uploadable: schema fields, limits, assets, test pack, no secrets. */
import { describe, expect, it } from 'vitest';
import { PLUGIN_DIR, listingUrls, readPlugin, validatePlugin } from '../scripts/chatgpt-plugin.mjs';
import { DOCS_PAGES, LEGAL_PAGES } from '../src/content';

/** plugin.json with `edit` applied, validated against the real package files. */
function validateEdited(edit: (plugin: any) => void): string[] {
  const plugin = readPlugin();
  edit(plugin);
  return validatePlugin(PLUGIN_DIR, plugin);
}

describe('ChatGPT plugin package', () => {
  it('passes validation as committed', () => {
    expect(validatePlugin()).toEqual([]);
  });

  it('points at anymd.cc pages that this app serves', () => {
    const urls = listingUrls();
    expect(urls.length).toBe(4);
    const served = new Set(['https://anymd.cc', ...DOCS_PAGES.map((p) => `https://anymd.cc/docs/${p.slug}`), ...LEGAL_PAGES.map((p) => `https://anymd.cc/legal/${p.slug}`)]);
    for (const url of urls) expect(served.has(url), url).toBe(true);
  });

  it('catches over-long listing copy, a wrong test pack size and shipped credentials', () => {
    const errors = validateEdited((p) => {
      p.extensions['com.openai'].interface.shortDescription = 'x'.repeat(31);
      p.extensions['com.openai'].review.test_cases.positive.pop();
      p.extensions['com.openai'].review.test_credentials = { email: 'reviewer@example.com' };
    });
    expect(errors.some((e) => e.includes('shortDescription'))).toBe(true);
    expect(errors.some((e) => e.includes('exactly 5'))).toBe(true);
    expect(errors.some((e) => e.includes('test_credentials'))).toBe(true);
  });

  it('finds a credential pasted into listing copy', () => {
    const errors = validateEdited((p) => {
      p.extensions['com.openai'].interface.defaultPrompt[0] = 'Use key amd_0123456789abcdef to read https://example.com';
    });
    expect(errors.some((e) => e.includes('defaultPrompt[0] looks like it holds a credential'))).toBe(true);
  });

  it('rejects non-https policy URLs and missing assets', () => {
    const errors = validateEdited((p) => {
      p.extensions['com.openai'].interface.privacyPolicyURL = 'http://anymd.cc/legal/privacy';
      p.extensions['com.openai'].interface.logo = './assets/missing.png';
    });
    expect(errors.some((e) => e.includes('privacyPolicyURL'))).toBe(true);
    expect(errors.some((e) => e.includes('interface.logo'))).toBe(true);
  });
});
