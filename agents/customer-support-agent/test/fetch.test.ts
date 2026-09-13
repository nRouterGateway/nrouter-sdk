import { describe, it, expect, vi } from 'vitest';
import { isBlockedHost, isSafeUrl, fetchSeedPages, htmlToText } from '../src/knowledge/fetch.js';

describe('isBlockedHost', () => {
  it('blocks localhost variants', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('test.localhost')).toBe(true);
    expect(isBlockedHost('my.local')).toBe(true);
    expect(isBlockedHost('my.internal')).toBe(true);
  });

  it('blocks IPv4 loopback and private', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('127.123.0.1')).toBe(true);
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('172.31.255.255')).toBe(true);
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('100.64.0.1')).toBe(true);
    expect(isBlockedHost('0.0.0.0')).toBe(true);
  });

  it('allows public IPv4 and valid hosts', () => {
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('172.32.0.1')).toBe(false); // outside 172.16/12
    expect(isBlockedHost('192.169.1.1')).toBe(false);
    expect(isBlockedHost('example.com')).toBe(false);
  });

  it('blocks IPv6 loopback, local and mapped', () => {
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('[::1]')).toBe(true); // handled via normalization in caller or strip brackets
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost('fc00::1')).toBe(true);
    expect(isBlockedHost('fd00::1')).toBe(true);
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('does not block domains starting with IPv6 prefixes', () => {
    expect(isBlockedHost('fcbarcelona.com')).toBe(false);
    expect(isBlockedHost('fdic.gov')).toBe(false);
    expect(isBlockedHost('fe99.org')).toBe(false);
  });

  it('blocks additional IPv4 and IPv6 restricted addresses', () => {
    expect(isBlockedHost('::')).toBe(true);
    expect(isBlockedHost('192.0.0.1')).toBe(true);
    expect(isBlockedHost('198.18.0.1')).toBe(true);
    expect(isBlockedHost('224.1.2.3')).toBe(true);
    expect(isBlockedHost('255.255.255.255')).toBe(true);
  });
});

describe('isSafeUrl', () => {
  it('allows safe urls', () => {
    expect(isSafeUrl('https://example.com/page')).toBe(true);
    expect(isSafeUrl('http://8.8.8.8/')).toBe(true);
  });

  it('blocks non-http schemes', () => {
    expect(isSafeUrl('ftp://example.com')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('blocks urls with userinfo', () => {
    expect(isSafeUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeUrl('https://user@example.com')).toBe(false);
  });

  it('blocks SSRF targets by resolving numeric/hex/octal IPv4', () => {
    expect(isSafeUrl('http://2130706433')).toBe(false); // 127.0.0.1
    expect(isSafeUrl('http://0177.0.0.1')).toBe(false); // 127.0.0.1
    expect(isSafeUrl('http://0x7f000001')).toBe(false); // 127.0.0.1
  });
});

describe('fetchSeedPages', () => {
  it('fetches page and handles redirects, refusing private hosts', async () => {
    let reqCount = 0;
    const fakeFetch = async (url: string, init: any) => {
      reqCount++;
      if (url === 'https://example.com/start') {
        return {
          status: 301,
          headers: new Headers({ location: 'http://127.0.0.1/private' })
        } as any;
      }
      return { status: 404 } as any;
    };
    
    const docs = await fetchSeedPages(['https://example.com/start'], { fetchImpl: fakeFetch as any });
    expect(docs).toEqual([]);
    expect(reqCount).toBe(1); // Stopped before following to 127.0.0.1
  });

  it('respects byte cap', async () => {
    const fakeFetch = async (url: string) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('A'.repeat(500)));
          controller.enqueue(new TextEncoder().encode('B'.repeat(1000))); // Exceeds cap of 1000
          controller.close();
        }
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: stream
      } as any;
    };

    const docs = await fetchSeedPages(['https://example.com/huge'], { fetchImpl: fakeFetch as any, maxBytes: 1000 });
    expect(docs.length).toBe(1);
    expect(docs[0]!.content.length).toBeLessThanOrEqual(1000);
  });

  it('skips failures without throwing', async () => {
    const fakeFetch = async () => { throw new Error('Network error'); };
    const docs = await fetchSeedPages(['https://example.com/error'], { fetchImpl: fakeFetch as any });
    expect(docs).toEqual([]);
  });

  it('bounds body read time so a hanging stream does not stall', async () => {
    const fakeFetch = async (url: string, init: any) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('A'));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        }
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: stream
      } as any;
    };
    
    const docs = await fetchSeedPages(['https://example.com/hang'], { fetchImpl: fakeFetch as any, timeoutMs: 50 });
    expect(docs).toEqual([]);
  }, 1000);
});

describe('htmlToText', () => {
  it('strips chrome and extracts title', () => {
    const html = `
      <html>
        <head><title>  My Page  </title></head>
        <body>
          <nav>Ignore me</nav>
          <main>
            <h1>Heading</h1>
            <p>Some text with &amp; entity.</p>
            <script>alert(1)</script>
          </main>
          <footer>Footer text</footer>
        </body>
      </html>
    `;
    const res = htmlToText(html);
    expect(res.title).toBe('My Page');
    expect(res.text).toContain('Heading');
    expect(res.text).toContain('Some text with & entity.');
    expect(res.text).not.toContain('Ignore me');
    expect(res.text).not.toContain('Footer text');
    expect(res.text).not.toContain('alert(1)');
  });
});
