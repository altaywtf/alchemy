import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Queue } from "./Queue.ts";
import { makeWriteQueueClient } from "./QueueClient.ts";
import { WriteQueue } from "./WriteQueue.ts";

/**
 * {@link WriteQueue} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Queue
 * @provides Modal.WriteQueue
 */
export const WriteQueueHttp = Layer.effect(
  WriteQueue,
  makeModalBinding({
    tag: "Modal.WriteQueue",
    make: Effect.fn(function* (queue: Queue, client) {
      return makeWriteQueueClient(yield* queue.queueId, client);
    }),
  }),
);
