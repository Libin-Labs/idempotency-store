import { createIdempotencyStore, type JsonValue } from '@lp-labs/idempotency-store';

const store = createIdempotencyStore();
const result: Promise<JsonValue> = store.execute('request-1', 'fingerprint-1', () => ({
  ok: true,
}));
void result;
