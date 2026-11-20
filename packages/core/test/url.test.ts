import { expect, test } from 'bun:test';
import { normalizeProfileUrl } from '../src/linkedin/url';

test.each([
  ['https://www.linkedin.com/in/Jane-Doe/', 'jane-doe', 'Jane-Doe'],
  ['https://www.linkedin.com/in/jane-doe?trk=abc', 'jane-doe', 'jane-doe'],
  ['linkedin.com/in/jane-doe', 'jane-doe', 'jane-doe'],
  ['https://m.linkedin.com/in/jane-doe', 'jane-doe', 'jane-doe'],
  ['https://www.linkedin.com/en/in/jane-doe/details/experience/', 'jane-doe', 'jane-doe'],
])('normalizes %s', (input, slug, handle) => {
  expect(normalizeProfileUrl(input)).toEqual({ url: `https://www.linkedin.com/in/${slug}`, handle });
});

test.each([
  [''],
  [null],
  ['https://example.com/in/jane'],
  ['https://evil-linkedin.com/in/jane'],
  ['https://www.linkedin.com/company/acme'],
  ['https://www.linkedin.com/in/'],
])('rejects %p', (input) => {
  expect(normalizeProfileUrl(input)).toBeNull();
});
