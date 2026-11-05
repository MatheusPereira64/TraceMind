/**
 * Only allow same-origin relative paths as post-login destinations, to avoid open redirects
 * (`?next=https://evil.example` or protocol-relative `//evil.example`).
 */
export function safeRedirectPath(value: string | null | undefined, fallback = '/overview'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  return value;
}
