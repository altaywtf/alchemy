import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Queue } from "./Queue.ts";
import { makeReadWriteQueueClient } from "./QueueClient.ts";
import { ReadWriteQueue } from "./ReadWriteQueue.ts";

/**
 * {@link ReadWriteQueue} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Queue
 * @provides Modal.ReadWriteQueue
 */
export const ReadWriteQueueHttp = Layer.effect(
  ReadWriteQueue,
  makeModalBinding({
    tag: "Modal.ReadWriteQueue",
    make: Effect.fn(function* (queue: Queue, client) {
      return makeReadWriteQueueClient(yield* queue.queueId, client);
    }),
  }),
);
