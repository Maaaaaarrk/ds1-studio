import { describe, expect, it, vi } from 'vitest';
import { bugReportUrl, featureRequestUrl, REPO_URL } from '../src/app/updates';

describe('GitHub issue links', () => {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });

  it('pre-fills a feature request with the idea layout, label and environment', () => {
    const url = new URL(featureRequestUrl({ map: 'data/global/tiles/act1/town/townN1.ds1' }));
    expect(`${url.origin}${url.pathname}`).toBe(`${REPO_URL}/issues/new`);
    expect(url.searchParams.get('title')).toBe('[Idea] ');
    expect(url.searchParams.get('labels')).toBe('enhancement');
    const body = url.searchParams.get('body')!;
    expect(body).toMatch(/### What would you like to do\?/);
    expect(body).toMatch(/### How would it work\?/);
    expect(body).toMatch(/- DS1 Studio /);
    expect(body).toContain('- Map open: `data/global/tiles/act1/town/townN1.ds1`');
    expect(new URL(featureRequestUrl({})).searchParams.get('body')).toContain('- Map open: (none)');
  });

  it('keeps bug reports labelled as bugs', () => {
    const url = new URL(bugReportUrl({ map: null }));
    expect(url.searchParams.get('labels')).toBe('bug');
    expect(url.searchParams.get('title')).toBe('[Bug] ');
  });
});
