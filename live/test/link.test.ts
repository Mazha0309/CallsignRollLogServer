import assert from 'node:assert/strict';
import test from 'node:test';

test('consumePublicLink retains a valid LiveShare token in the URL fragment', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const location = {
    pathname: '/live/share-1',
    search: '',
    hash: '#token=secret-value-at-least-32-characters',
  };
  let replaceStateCalls = 0;
  Object.assign(globalThis, {
    window: {
      location,
      history: {
        state: null,
        replaceState: () => { replaceStateCalls += 1; },
      },
    },
    document: { title: 'Callsign Roll Log Live' },
  });

  try {
    const { consumePublicLink } = await import(`../src/link.ts?test=${Date.now()}`);
    const link = consumePublicLink();

    assert.equal(link.publicShareId, 'share-1');
    assert.equal(link.secret, 'secret-value-at-least-32-characters');
    assert.equal(window.location.hash, '#token=secret-value-at-least-32-characters');
    assert.equal(replaceStateCalls, 0);
  } finally {
    Object.assign(globalThis, { window: originalWindow, document: originalDocument });
  }
});
