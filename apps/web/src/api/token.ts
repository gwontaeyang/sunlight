// The per-start API token is injected into index.html as <meta name="sp-token"> (PLAN 3). Never put it in
// URLs, cookies or storage.
export const TOKEN_HEADER = 'X-SP-Token';

export function readTokenFromDocument(doc: Document = document): string {
  return doc.querySelector('meta[name="sp-token"]')?.getAttribute('content') ?? '';
}

/** Fired once the server answers 401 (token rotated by a server restart → the page must be reloaded). */
export const TOKEN_EXPIRED_EVENT = 'sp:token-expired';

/** True only under Playwright (the server adds <meta name="sp-e2e"> when SP_E2E=1): gates window test hooks. */
export function isE2e(doc: Document = document): boolean {
  return doc.querySelector('meta[name="sp-e2e"]') !== null;
}
