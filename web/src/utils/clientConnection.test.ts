import { expect, test } from 'vitest';
import { clientConnectionUrl } from './clientConnection';

test('handoff carries only the server origin, never credentials or tokens', () => {
  const target = new URL(clientConnectionUrl('https://client.example/client/', 'https://server.example/connect?token=secret')!);
  expect(target.pathname).toBe('/client/');
  expect([...target.searchParams.entries()]).toEqual([['page', 'settings'], ['server', 'https://server.example']]);
  for (const value of ['', 'javascript:alert(1)', '//site.test', 'https://u:p@site.test/', 'https://site.test/?token=secret']) {
    expect(clientConnectionUrl(value, 'https://server.example')).toBeNull();
  }
});
