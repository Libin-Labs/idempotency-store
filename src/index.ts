export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface IdempotencyStoreOptions {
  maxEntries?: number;
  pendingTtlMs?: number;
  completedTtlMs?: number;
  clock?: () => number;
}

export interface IdempotencyStore {
  execute(
    key: string,
    fingerprint: string,
    operation: () => JsonValue | PromiseLike<JsonValue>,
  ): Promise<JsonValue>;
  size(): number;
}

export class IdempotencyError extends Error {
  constructor(
    readonly code: 'invalid' | 'capacity' | 'conflict' | 'clock',
    message: string,
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

function clone(value: unknown): JsonValue {
  let nodes = 0;
  let characters = 0;
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 10_000 || depth > 32)
      throw new IdempotencyError('capacity', 'Result exceeds JSON node or nesting limits.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      characters += item.length;
      if (characters > 1_000_000)
        throw new IdempotencyError('capacity', 'Result exceeds the one-million-character limit.');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1)
        throw new IdempotencyError(
          'invalid',
          'Arrays must be dense and contain no extra properties.',
        );
      const result: JsonValue[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new IdempotencyError('invalid', 'Arrays must contain enumerable data elements.');
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    if (
      typeof item !== 'object' ||
      (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
    )
      throw new IdempotencyError('invalid', 'Values must be plain JSON-compatible data.');
    const entries: [string, JsonValue][] = [];
    for (const key of Reflect.ownKeys(item)) {
      const descriptor =
        typeof key === 'string' ? Object.getOwnPropertyDescriptor(item, key) : undefined;
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
        throw new IdempotencyError(
          'invalid',
          'Objects must use enumerable string data properties.',
        );
      characters += key.length;
      if (characters > 1_000_000)
        throw new IdempotencyError('capacity', 'Result exceeds the one-million-character limit.');
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    return Object.fromEntries(entries) as { [key: string]: JsonValue };
  };
  return visit(value, 0);
}

interface PendingEntry {
  fingerprint: string;
  expiresAt: number;
  status: 'pending';
  promise: Promise<JsonValue>;
}

interface CompletedEntry {
  fingerprint: string;
  expiresAt: number;
  status: 'completed';
  value: JsonValue;
}

type Entry = PendingEntry | CompletedEntry;

export function createIdempotencyStore(options: IdempotencyStoreOptions = {}): IdempotencyStore {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  )
    throw new IdempotencyError('invalid', 'Options must be a plain object.');
  for (const key of Reflect.ownKeys(options)) {
    const descriptor =
      typeof key === 'string' ? Object.getOwnPropertyDescriptor(options, key) : undefined;
    if (
      typeof key !== 'string' ||
      !['maxEntries', 'pendingTtlMs', 'completedTtlMs', 'clock'].includes(key) ||
      !descriptor?.enumerable ||
      !('value' in descriptor)
    )
      throw new IdempotencyError('invalid', 'Options contain an unsupported field or accessor.');
  }
  const maxEntries = options.maxEntries ?? 10_000;
  const pendingTtlMs = options.pendingTtlMs ?? 60_000;
  const completedTtlMs = options.completedTtlMs ?? 86_400_000;
  const clock = options.clock ?? Date.now;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000)
    throw new IdempotencyError('invalid', 'maxEntries must be an integer from 1 to 1000000.');
  for (const [name, value] of [
    ['pendingTtlMs', pendingTtlMs],
    ['completedTtlMs', completedTtlMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new IdempotencyError('invalid', `${name} must be a positive safe integer.`);
  }
  if (typeof clock !== 'function')
    throw new IdempotencyError('invalid', 'clock must be a function.');
  const entries = new Map<string, Entry>();
  let lastTime = -Infinity;
  const now = (): number => {
    const value = clock();
    if (!Number.isSafeInteger(value))
      throw new IdempotencyError('clock', 'clock must return a safe integer.');
    lastTime = Math.max(lastTime, value);
    return lastTime;
  };
  return {
    size() {
      const time = now();
      for (const [key, entry] of entries) {
        if (entry.expiresAt < time) entries.delete(key);
      }
      return entries.size;
    },
    execute(key, fingerprint, operation) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 256)
        throw new IdempotencyError('invalid', 'key must contain 1..256 characters.');
      if (typeof fingerprint !== 'string' || fingerprint.length < 1 || fingerprint.length > 512)
        throw new IdempotencyError('invalid', 'fingerprint must contain 1..512 characters.');
      if (typeof operation !== 'function')
        throw new IdempotencyError('invalid', 'operation must be a function.');
      const time = now();
      for (const [candidate, entry] of entries) {
        if (entry.expiresAt < time) entries.delete(candidate);
      }
      const existing = entries.get(key);
      if (existing && existing.expiresAt >= time) {
        if (existing.fingerprint !== fingerprint)
          throw new IdempotencyError(
            'conflict',
            'Key is already associated with another fingerprint.',
          );
        return existing.status === 'pending'
          ? existing.promise.then(clone)
          : Promise.resolve(clone(existing.value));
      }
      if (existing) entries.delete(key);
      if (entries.size >= maxEntries)
        throw new IdempotencyError(
          'capacity',
          'Store is full; expired entries are removed on access or size().',
        );
      const pendingUntil = time + pendingTtlMs;
      if (!Number.isSafeInteger(pendingUntil))
        throw new IdempotencyError('clock', 'Pending expiration exceeds safe integer bounds.');
      const entry: PendingEntry = {
        fingerprint,
        expiresAt: pendingUntil,
        status: 'pending',
        promise: Promise.resolve(null),
      };
      const promise = Promise.resolve()
        .then(operation)
        .then((result) => {
          const value = clone(result);
          if (entries.get(key) === entry) {
            const completedUntil = now() + completedTtlMs;
            if (!Number.isSafeInteger(completedUntil))
              throw new IdempotencyError(
                'clock',
                'Completed expiration exceeds safe integer bounds.',
              );
            entries.set(key, {
              fingerprint,
              expiresAt: completedUntil,
              status: 'completed',
              value,
            });
          }
          return clone(value);
        })
        .catch((error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        });
      entry.promise = promise;
      entries.set(key, entry);
      return promise.then(clone);
    },
  };
}
