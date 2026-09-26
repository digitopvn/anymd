import { describe, expect, it } from 'vitest';
import { isPathAllowed, robotsRules } from '../src/convert/robots';
import { normalizeOptoutDomain, optoutCandidates } from '../src/convert/optouts';

const allowed = (robots: string, path: string) => isPathAllowed(robotsRules(robots), path);

describe('robots.txt', () => {
  it('uses the anymd group over the * group', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: anymd\nDisallow: /private\n';
    expect(allowed(txt, '/blog/post')).toBe(true);
    expect(allowed(txt, '/private/x')).toBe(false);
  });

  it('falls back to the * group and treats an empty Disallow as allow-all', () => {
    expect(allowed('User-agent: *\nDisallow: /admin', '/admin/users')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /admin', '/about')).toBe(true);
    expect(allowed('User-agent: *\nDisallow:', '/anything')).toBe(true);
    expect(allowed('User-agent: googlebot\nDisallow: /', '/anything')).toBe(true);
  });

  it('matches the token case-insensitively and supports grouped user-agent lines', () => {
    const txt = 'User-agent: GPTBot\nUser-agent: AnyMD\nDisallow: /\n';
    expect(allowed(txt, '/')).toBe(false);
  });

  it('picks the longest match and lets Allow win ties', () => {
    const txt = 'User-agent: anymd\nDisallow: /docs\nAllow: /docs/public\nAllow: /same\nDisallow: /same\n';
    expect(allowed(txt, '/docs/secret')).toBe(false);
    expect(allowed(txt, '/docs/public/page')).toBe(true);
    expect(allowed(txt, '/same')).toBe(true);
  });

  it('supports * and $ wildcards and ignores comments', () => {
    const txt = 'User-agent: anymd # us\nDisallow: /*.pdf$\nDisallow: /search?*q=\n';
    expect(allowed(txt, '/files/report.pdf')).toBe(false);
    expect(allowed(txt, '/files/report.pdf?x=1')).toBe(true);
    expect(allowed(txt, '/search?lang=en&q=test')).toBe(false);
  });

  it('always allows /robots.txt', () => {
    expect(allowed('User-agent: *\nDisallow: /', '/robots.txt')).toBe(true);
  });
});

describe('site opt-outs', () => {
  it('normalizes domains and URLs', () => {
    expect(normalizeOptoutDomain('https://WWW.Example.com/path')).toBe('example.com');
    expect(normalizeOptoutDomain(' blog.example.co.uk ')).toBe('blog.example.co.uk');
    expect(normalizeOptoutDomain('localhost')).toBeNull();
    expect(normalizeOptoutDomain('not a domain')).toBeNull();
    expect(normalizeOptoutDomain('')).toBeNull();
  });

  it('checks the host and each parent domain', () => {
    expect(optoutCandidates('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
    expect(optoutCandidates('www.example.com')).toEqual(['example.com']);
  });
});
