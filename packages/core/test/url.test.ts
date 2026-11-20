import { expect, test } from 'bun:test';
import { linkedInTarget } from '../src/linkedin/target';
import { sameSite, siteDomain } from '../src/linkedin/url';

test.each([
  ['https://www.linkedin.com/in/Jane-Doe/', 'Jane-Doe'],
  ['https://www.linkedin.com/in/jane-doe?trk=abc', 'jane-doe'],
  ['https://m.linkedin.com/in/jane-doe', 'jane-doe'],
  ['https://uk.linkedin.com/in/jane-doe', 'jane-doe'],
  ['https://www.linkedin.com/en/in/jane-doe/details/experience/', 'jane-doe'],
])('profile target from %s', (input, slug) => {
  expect(linkedInTarget(input)).toEqual({ kind: 'profile', slug });
});

test.each([[''], [null], ['https://example.com/in/jane'], ['https://evil-linkedin.com/in/jane'], ['https://www.linkedin.com/in/'], ['https://www.linkedin.com/feed/']])(
  'no target for %p',
  (input) => {
    expect(linkedInTarget(input)).toBeNull();
  },
);

test('domains', () => {
  expect(siteDomain('https://www.Example.co.uk/careers')).toBe('example.co.uk');
  expect(siteDomain('example.com')).toBe('example.com');
  expect(sameSite('jobs.example.com', 'example.com')).toBe(true);
  expect(sameSite('example-hr.net', 'example.com')).toBe(false);
});
