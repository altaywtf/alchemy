import * as queue from "@distilled.cloud/modal/queue";
import * as Effect from "effect/Effect";
import { decodeJson, encodeJson } from "./BindingHttp.ts";
import { seconds } from "./internal.ts";
import type { ModalClient } from "./ModalBindings.ts";

/** Which partition of a queue a call uses; omitted means the default partition. */
export interface QueuePartitionOptions {
  readonly partition?: string;
}

/**
 * Take items from one queue. Items are JSON (the bytes of `JSON.stringify`),
 * so Python consumers read them with `json.loads`.
 */
export interface ReadQueueClient {
  readonly queueId: Effect.Effect<string>;
  /**
   * Remove and return up to `count` items, waiting up to `timeout` for the
   * first one (an empty array when none arrived).
   */
  take<A = unknown>(
    options?: QueuePartitionOptions & {
      readonly count?: number;
      readonly timeout?: number | string;
    },
  ): Effect.Effect<ReadonlyArray<A>, any>;
  /** Items currently in the queue, without removing them. */
  peek<A = unknown>(options?: QueuePartitionOptions): Effect.Effect<ReadonlyArray<A>, any>;
  /** Number of items in a partition (or, with `total`, in every partition). */
  len(options?: QueuePartitionOptions & { readonly total?: boolean }): Effect.Effect<number, any>;
}

/** Put items into one queue. */
export interface WriteQueueClient {
  readonly queueId: Effect.Effect<string>;
  /** Append one item. */
  put(
    value: unknown,
    options?: QueuePartitionOptions & { readonly partitionTtl?: number | string },
  ): Effect.Effect<void, any>;
  /** Append many items in order. */
  putMany(
    values: Iterable<unknown>,
    options?: QueuePartitionOptions & { readonly partitionTtl?: number | string },
  ): Effect.Effect<void, any>;
  /** Remove every item of a partition (or of all partitions). */
  clear(options?: QueuePartitionOptions & { readonly all?: boolean }): Effect.Effect<void, any>;
}

/** Put and take items. */
export interface ReadWriteQueueClient extends ReadQueueClient, WriteQueueClient {}

export const makeReadQueueClient = (
  queueId: Effect.Effect<string>,
  client: ModalClient,
): ReadQueueClient => ({
  queueId,
  take: (options = {}) =>
    client(
      Effect.gen(function* () {
        const { values } = yield* queue.getQueue({
          queueId: yield* queueId,
          partitionKey: options.partition,
          nValues: options.count ?? 1,
          timeout: seconds(options.timeout) ?? 0,
        });
        return yield* Effect.forEach(values ?? [], (value) => decodeJson(value));
      }),
    ) as any,
  peek: (options = {}) =>
    client(
      Effect.gen(function* () {
        const { items } = yield* queue.queueNextItems({
          queueId: yield* queueId,
          partitionKey: options.partition,
          itemPollTimeout: 0,
        });
        return yield* Effect.forEach(items ?? [], (item) => decodeJson(item.value ?? ""));
      }),
    ) as any,
  len: (options = {}) =>
    client(
      Effect.gen(function* () {
        const response = yield* queue.queueLen({
          queueId: yield* queueId,
          partitionKey: options.partition,
          total: options.total,
        });
        return response.len ?? 0;
      }),
    ),
});

export const makeWriteQueueClient = (
  queueId: Effect.Effect<string>,
  client: ModalClient,
): WriteQueueClient => {
  const putMany: WriteQueueClient["putMany"] = (values, options = {}) =>
    client(
      Effect.gen(function* () {
        const encoded = yield* Effect.forEach([...values], (value) => encodeJson(value));
        yield* queue.putQueue({
          queueId: yield* queueId,
          values: encoded,
          partitionKey: options.partition,
          partitionTtlSeconds: seconds(options.partitionTtl),
        });
      }),
    );
  return {
    queueId,
    put: (value, options) => putMany([value], options),
    putMany,
    clear: (options = {}) =>
      client(
        Effect.gen(function* () {
          yield* queue.clearQueue({
            queueId: yield* queueId,
            partitionKey: options.partition,
            allPartitions: options.all,
          });
        }),
      ),
  };
};

export const makeReadWriteQueueClient = (
  queueId: Effect.Effect<string>,
  client: ModalClient,
): ReadWriteQueueClient => ({
  ...makeReadQueueClient(queueId, client),
  ...makeWriteQueueClient(queueId, client),
});
