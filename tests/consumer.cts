import storeModule = require('@lp-labs/idempotency-store');

const store: storeModule.IdempotencyStore = storeModule.createIdempotencyStore();
void store.execute('request-1', 'fingerprint-1', () => null);
