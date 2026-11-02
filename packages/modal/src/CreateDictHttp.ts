import * as dict from "@distilled.cloud/modal/dict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateDict, type DictHandle, type DictsClient } from "./CreateDict.ts";
import { ensureDict, lookupDict, type DictAttributes } from "./Dict.ts";
import { makeReadWriteDictClient } from "./DictClient.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll } from "./internal.ts";
import type { ModalClient } from "./ModalBindings.ts";

const handleOf = (attributes: DictAttributes, client: ModalClient): DictHandle => ({
  ...makeReadWriteDictClient(Effect.succeed(attributes.dictId), client),
  dictId: Effect.succeed(attributes.dictId),
  name: attributes.name,
  attributes,
});

/** A dicts client over an environment name resolved per call. */
export const makeDictsClient = (
  environment: Effect.Effect<string | undefined>,
  client: ModalClient,
): DictsClient => ({
  getOrCreate: (name) =>
    client(Effect.flatMap(environment, (env) => ensureDict(name, env))).pipe(
      Effect.map((attributes) => handleOf(attributes, client)),
    ),
  get: (name) =>
    client(Effect.flatMap(environment, (env) => lookupDict(name, env))).pipe(
      Effect.map((attributes) => (attributes ? handleOf(attributes, client) : undefined)),
    ),
  delete: (name) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const found = yield* lookupDict(name, env);
        if (!found) return;
        yield* dict
          .deleteDict({ dictId: found.dictId })
          .pipe(Effect.catchTag("DictNotFound", () => Effect.void));
      }),
    ),
  list: () =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const items = yield* listAll(
          (pagination) =>
            dict
              .listDict({ environmentName: environmentOf(env), pagination })
              .pipe(Effect.map((response) => response.dicts ?? [])),
          (item) => item.createdAt,
        );
        return items.flatMap((item) => (item.name ? [item.name] : []));
      }),
    ),
});

/**
 * {@link CreateDict} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Dict
 * @provides Modal.CreateDict
 */
export const CreateDictHttp = Layer.effect(
  CreateDict,
  makeOpenModalBinding({
    tag: "Modal.CreateDict",
    make: Effect.fn(function* (client, environment?: Environment) {
      const name = environment ? yield* environment.name : Effect.succeed(undefined);
      return makeDictsClient(name, client);
    }),
  }),
);
