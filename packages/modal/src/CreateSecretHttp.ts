import * as secret from "@distilled.cloud/modal/secret";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateSecret, type SecretsClient } from "./CreateSecret.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll } from "./internal.ts";
import type { ModalClient } from "./ModalBindings.ts";
import { lookupSecret, putSecret } from "./Secret.ts";

/** A secrets client over an environment name resolved per call. */
export const makeSecretsClient = (
  environment: Effect.Effect<string | undefined>,
  client: ModalClient,
): SecretsClient => ({
  put: (name, env) => client(Effect.flatMap(environment, (e) => putSecret(name, e, env))),
  get: (name) => client(Effect.flatMap(environment, (e) => lookupSecret(name, e))),
  delete: (name) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const found = yield* lookupSecret(name, env);
        if (!found) return;
        yield* secret
          .deleteSecret({ secretId: found.secretId })
          .pipe(Effect.catchTag("SecretNotFound", () => Effect.void));
      }),
    ),
  list: () =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const items = yield* listAll(
          (pagination) =>
            secret
              .listSecret({ environmentName: environmentOf(env), pagination })
              .pipe(Effect.map((response) => response.items ?? [])),
          (item) => item.createdAt,
        );
        return items.flatMap((item) => {
          const name = item.label ?? item.metadata?.name;
          return name ? [name] : [];
        });
      }),
    ),
});

/**
 * {@link CreateSecret} over Modal's API. Binds the deployer's Modal token onto
 * the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Secret
 * @provides Modal.CreateSecret
 */
export const CreateSecretHttp = Layer.effect(
  CreateSecret,
  makeOpenModalBinding({
    tag: "Modal.CreateSecret",
    make: Effect.fn(function* (client, environment?: Environment) {
      const name = environment ? yield* environment.name : Effect.succeed(undefined);
      return makeSecretsClient(name, client);
    }),
  }),
);
