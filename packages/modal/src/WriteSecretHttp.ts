import * as secret from "@distilled.cloud/modal/secret";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeModalBinding } from "./BindingHttp.ts";
import type { ModalClient } from "./ModalBindings.ts";
import type { Secret } from "./Secret.ts";
import { WriteSecret, type WriteSecretClient } from "./WriteSecret.ts";

/** A write client over a secret id. */
export const makeWriteSecretClient = (
  secretId: Effect.Effect<string>,
  client: ModalClient,
): WriteSecretClient => ({
  secretId,
  put: (env) =>
    client(
      Effect.gen(function* () {
        const id = yield* secretId;
        const { metadata } = yield* secret.secretGetInfo({ secretId: id });
        const values = Object.entries(env).map(([key, value]) => ({
          key,
          value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
        }));
        const removed = (metadata?.keys ?? []).filter((key) => !(key in env));
        yield* secret.updateSecret({
          secretId: id,
          updates: [...values, ...removed.map((key) => ({ key }))],
        });
      }),
    ),
});

/**
 * {@link WriteSecret} over Modal's API. Binds the deployer's Modal token onto
 * the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Secret
 * @provides Modal.WriteSecret
 */
export const WriteSecretHttp = Layer.effect(
  WriteSecret,
  makeModalBinding({
    tag: "Modal.WriteSecret",
    make: Effect.fn(function* (resource: Secret, client) {
      const secretId = yield* resource.secretId;
      return makeWriteSecretClient(secretId, client);
    }),
  }),
);
