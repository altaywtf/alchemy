import * as queue from "@distilled.cloud/modal/queue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateQueue, type QueueHandle, type QueuesClient } from "./CreateQueue.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll } from "./internal.ts";
import type { ModalClient } from "./ModalBindings.ts";
import { ensureQueue, lookupQueue, type QueueAttributes } from "./Queue.ts";
import { makeReadWriteQueueClient } from "./QueueClient.ts";

const handleOf = (attributes: QueueAttributes, client: ModalClient): QueueHandle => ({
  ...makeReadWriteQueueClient(Effect.succeed(attributes.queueId), client),
  queueId: Effect.succeed(attributes.queueId),
  name: attributes.name,
  attributes,
});

/** A queues client over an environment name resolved per call. */
export const makeQueuesClient = (
  environment: Effect.Effect<string | undefined>,
  client: ModalClient,
): QueuesClient => ({
  getOrCreate: (name) =>
    client(Effect.flatMap(environment, (env) => ensureQueue(name, env))).pipe(
      Effect.map((attributes) => handleOf(attributes, client)),
    ),
  get: (name) =>
    client(Effect.flatMap(environment, (env) => lookupQueue(name, env))).pipe(
      Effect.map((attributes) => (attributes ? handleOf(attributes, client) : undefined)),
    ),
  delete: (name) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const found = yield* lookupQueue(name, env);
        if (!found) return;
        yield* queue
          .deleteQueue({ queueId: found.queueId })
          .pipe(Effect.catchTag("QueueNotFound", () => Effect.void));
      }),
    ),
  list: () =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const items = yield* listAll(
          (pagination) =>
            queue
              .listQueue({ environmentName: environmentOf(env), pagination })
              .pipe(Effect.map((response) => response.queues ?? [])),
          (item) => item.createdAt,
        );
        return items.flatMap((item) => (item.name ? [item.name] : []));
      }),
    ),
});

/**
 * {@link CreateQueue} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Queue
 * @provides Modal.CreateQueue
 */
export const CreateQueueHttp = Layer.effect(
  CreateQueue,
  makeOpenModalBinding({
    tag: "Modal.CreateQueue",
    make: Effect.fn(function* (client, environment?: Environment) {
      const name = environment ? yield* environment.name : Effect.succeed(undefined);
      return makeQueuesClient(name, client);
    }),
  }),
);
