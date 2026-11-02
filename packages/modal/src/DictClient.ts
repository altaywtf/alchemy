import * as dict from "@distilled.cloud/modal/dict";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { decodeJson, encodeJson } from "./BindingHttp.ts";
import type { ModalClient } from "./ModalBindings.ts";

/**
 * Read access to one dict. Keys and values are JSON: `put("a", { n: 1 })`
 * stores the bytes of `JSON.stringify`, so Python code reads them with
 * `json.loads` (Modal's Python client pickles by default).
 */
export interface ReadDictClient {
  readonly dictId: Effect.Effect<string>;
  /** The value under `key`, or `undefined`. */
  get<A = unknown>(key: unknown): Effect.Effect<A | undefined, any, RuntimeContext>;
  /** Whether `key` is present. */
  contains(key: unknown): Effect.Effect<boolean, any, RuntimeContext>;
  /** Number of entries. */
  len(): Effect.Effect<number, any, RuntimeContext>;
  /** Every entry. */
  entries<A = unknown>(): Effect.Effect<ReadonlyArray<readonly [unknown, A]>, any, RuntimeContext>;
}

/** Write access to one dict. */
export interface WriteDictClient {
  readonly dictId: Effect.Effect<string>;
  /** Set `key` to `value`; with `ifNotExists`, only when absent (returns whether it wrote). */
  put(
    key: unknown,
    value: unknown,
    options?: { readonly ifNotExists?: boolean },
  ): Effect.Effect<boolean, any, RuntimeContext>;
  /** Set many entries at once. */
  update(entries: Iterable<readonly [unknown, unknown]>): Effect.Effect<void, any, RuntimeContext>;
  /** Remove `key` and return its value, or `undefined`. */
  pop<A = unknown>(key: unknown): Effect.Effect<A | undefined, any, RuntimeContext>;
  /** Remove every entry. */
  clear(): Effect.Effect<void, any, RuntimeContext>;
}

/** Read and write access to one dict. */
export interface ReadWriteDictClient extends ReadDictClient, WriteDictClient {}

export const makeReadDictClient = (
  dictId: Effect.Effect<string>,
  client: ModalClient,
): ReadDictClient => ({
  dictId,
  get: <A>(key: unknown) =>
    client(
      Effect.gen(function* () {
        const response = yield* dict.getDict({
          dictId: yield* dictId,
          key: yield* encodeJson(key),
        });
        return response.found && response.value !== undefined
          ? yield* decodeJson<A>(response.value)
          : undefined;
      }),
    ),
  contains: (key) =>
    client(
      Effect.gen(function* () {
        const response = yield* dict.dictContains({
          dictId: yield* dictId,
          key: yield* encodeJson(key),
        });
        return response.found ?? false;
      }),
    ),
  len: () =>
    client(
      Effect.gen(function* () {
        const response = yield* dict.dictLen({ dictId: yield* dictId });
        return response.len ?? 0;
      }),
    ),
  entries: <A>() =>
    client(
      Effect.gen(function* () {
        const { items } = yield* dict.dictContents({
          dictId: yield* dictId,
          keys: true,
          values: true,
        });
        return yield* Effect.forEach(items, (entry) =>
          Effect.all([decodeJson(entry.key ?? ""), decodeJson<A>(entry.value ?? "")] as const),
        );
      }),
    ),
});

export const makeWriteDictClient = (
  dictId: Effect.Effect<string>,
  client: ModalClient,
): WriteDictClient => ({
  dictId,
  put: (key, value, options = {}) =>
    client(
      Effect.gen(function* () {
        const response = yield* dict.updateDict({
          dictId: yield* dictId,
          updates: [{ key: yield* encodeJson(key), value: yield* encodeJson(value) }],
          ifNotExists: options.ifNotExists,
        });
        return options.ifNotExists ? (response.created ?? false) : true;
      }),
    ),
  update: (entries) =>
    client(
      Effect.gen(function* () {
        const updates = yield* Effect.forEach([...entries], ([key, value]) =>
          Effect.all({ key: encodeJson(key), value: encodeJson(value) }),
        );
        yield* dict.updateDict({ dictId: yield* dictId, updates });
      }),
    ),
  pop: <A>(key: unknown) =>
    client(
      Effect.gen(function* () {
        const response = yield* dict.dictPop({
          dictId: yield* dictId,
          key: yield* encodeJson(key),
        });
        return response.found && response.value !== undefined
          ? yield* decodeJson<A>(response.value)
          : undefined;
      }),
    ),
  clear: () =>
    client(
      Effect.gen(function* () {
        yield* dict.clearDict({ dictId: yield* dictId });
      }),
    ),
});

export const makeReadWriteDictClient = (
  dictId: Effect.Effect<string>,
  client: ModalClient,
): ReadWriteDictClient => ({
  ...makeReadDictClient(dictId, client),
  ...makeWriteDictClient(dictId, client),
});
