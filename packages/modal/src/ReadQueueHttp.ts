import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Queue } from "./Queue.ts";
import { makeReadQueueClient } from "./QueueClient.ts";
import { ReadQueue } from "./ReadQueue.ts";

/**
 * {@link ReadQueue} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Queue
 * @provides Modal.ReadQueue
 */
export const ReadQueueHttp = Layer.effect(
  ReadQueue,
  makeModalBinding({
    tag: "Modal.ReadQueue",
    make: Effect.fn(function* (queue: Queue, client) {
      return makeReadQueueClient(yield* queue.queueId, client);
    }),
  }),
);
