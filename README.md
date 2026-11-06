# @lp-labs/idempotency-store

A bounded, in-process idempotency cache for JSON-compatible results. Matching concurrent calls share work; a reused key with a different caller-supplied fingerprint is rejected.

## Install

```sh
npm install @lp-labs/idempotency-store
```

Node 18+ or ES2022 browsers. ESM, CommonJS, and declarations are included.

## Quick start

```js
import { createIdempotencyStore } from '@lp-labs/idempotency-store';

const store = createIdempotencyStore();
const response = await store.execute('checkout-req-17', 'cart:42:revision:8', async () => {
  return { orderId: 'order-17', accepted: true };
});
console.log(response.orderId);
```

CommonJS: `const { createIdempotencyStore } = require('@lp-labs/idempotency-store');`.

## API reference

Runtime exports: `createIdempotencyStore`, `IdempotencyError`.

Types: `JsonValue`, `IdempotencyStoreOptions`, `IdempotencyStore`.

### `createIdempotencyStore(options?): IdempotencyStore`

| Option           |    Default | Meaning                                                         |
| ---------------- | ---------: | --------------------------------------------------------------- |
| `maxEntries`     |    `10000` | Positive integer capacity, at most 1,000,000                    |
| `pendingTtlMs`   |    `60000` | Pending record expiry; after it passes, a new attempt may start |
| `completedTtlMs` | `86400000` | Successful result retention from completion time                |
| `clock`          | `Date.now` | Safe-integer millisecond clock; backwards movement is clamped   |

`execute(key, fingerprint, operation)` returns a promise of a cloned JSON value. Same key and fingerprint while pending share the execution; while complete, the cached result is returned. A different fingerprint for a still-live key throws `IdempotencyError` with code `conflict`. Failed operations are removed if their entry is still current, so a retry may execute. Result values are cloned and bounded to 10,000 nodes, 32 nested levels, and one million combined string/key characters.

`size()` removes expired records and returns the current count. Expiry is inclusive at the configured deadline; an entry is replaceable only when the observed clock is later than its expiration.

### Errors

`IdempotencyError.code` is `invalid`, `capacity`, `conflict`, or `clock`. Values must be plain JSON-compatible data (finite numbers, dense arrays, string-keyed plain records); unsupported values/accessors are rejected.

## Customization and limitations

Fingerprints must be derived by the application from the meaningful request identity and versioned/canonicalized as appropriate. Do not store raw secrets in keys or fingerprints. Capacity is strict: live entries are not evicted to make room. Pending expiration permits a retry even if the original operation is still running; a late completion cannot overwrite the newer record, but its original caller still receives its result.

This implementation is synchronous-map atomic only within one JavaScript process. It is not durable, shared between workers, or a transaction with your side effects. It cannot provide exactly-once execution: a crash after a side effect but before recording completion can lead to re-execution. Use an atomic durable backend plus transactional/outbox patterns when needed, and make the operation itself safe to retry. No distributed guarantee is implied.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
