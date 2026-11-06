import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyError, createIdempotencyStore } from '../dist/esm/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test('same key and fingerprint share an in-flight operation and cached JSON result', async () => {
  const store = createIdempotencyStore();
  const wait = deferred();
  let calls = 0;
  const first = store.execute('k', 'request-v1', async () => {
    calls++;
    return wait.promise;
  });
  const second = store.execute('k', 'request-v1', () => {
    calls++;
    return { never: true };
  });
  wait.resolve({ ok: true, nested: [1, 'a'] });
  assert.deepEqual(await first, { ok: true, nested: [1, 'a'] });
  assert.deepEqual(await second, { ok: true, nested: [1, 'a'] });
  assert.deepEqual(await store.execute('k', 'request-v1', () => null), {
    ok: true,
    nested: [1, 'a'],
  });
  assert.equal(calls, 1);
});

test('same key with a different fingerprint conflicts while pending or completed', async () => {
  const store = createIdempotencyStore();
  const wait = deferred();
  const pending = store.execute('key', 'a', () => wait.promise);
  assert.throws(() => store.execute('key', 'b', () => null), { code: 'conflict' });
  wait.resolve('done');
  await pending;
  assert.throws(() => store.execute('key', 'b', () => null), IdempotencyError);
});

test('failed work is not cached and a retry may execute', async () => {
  const store = createIdempotencyStore();
  await assert.rejects(
    store.execute('key', 'fp', () => Promise.reject(new Error('fail'))),
    /fail/,
  );
  assert.equal(
    await store.execute('key', 'fp', () => ({ retry: true })).then((value) => value.retry),
    true,
  );
});

test('expired pending entry can be replaced and stale completion cannot overwrite its successor', async () => {
  let time = 0;
  const store = createIdempotencyStore({ pendingTtlMs: 5, completedTtlMs: 100, clock: () => time });
  const old = deferred();
  const current = deferred();
  const oldCall = store.execute('key', 'fp', () => old.promise);
  time = 6;
  const newCall = store.execute('key', 'fp', () => current.promise);
  old.resolve({ generation: 'old' });
  assert.deepEqual(await oldCall, { generation: 'old' });
  assert.equal(store.size(), 1);
  current.resolve({ generation: 'new' });
  assert.deepEqual(await newCall, { generation: 'new' });
  assert.deepEqual(await store.execute('key', 'fp', () => null), { generation: 'new' });
});

test('completed expiry, backward clock clamping, and capacity are deterministic', async () => {
  let time = 10;
  const store = createIdempotencyStore({ maxEntries: 1, completedTtlMs: 3, clock: () => time });
  await store.execute('a', 'f', () => 1);
  time = 9;
  assert.equal(await store.execute('a', 'f', () => 2), 1);
  assert.throws(() => store.execute('b', 'f', () => 2), { code: 'capacity' });
  time = 14;
  assert.equal(await store.execute('b', 'f', () => 2), 2);
});

test('keys, fingerprints, options, and non-JSON values are checked', async () => {
  const store = createIdempotencyStore();
  assert.throws(() => store.execute('', 'f', () => 1), IdempotencyError);
  assert.throws(() => store.execute('k', '', () => 1), IdempotencyError);
  await assert.rejects(
    store.execute('bad', 'f', () => new Date()),
    IdempotencyError,
  );
  await assert.rejects(
    store.execute('large', 'f', () => 'x'.repeat(1_000_001)),
    {
      code: 'capacity',
    },
  );
  assert.throws(() => createIdempotencyStore({ maxEntries: 0 }), IdempotencyError);
});
