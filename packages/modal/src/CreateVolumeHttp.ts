import * as volume from "@distilled.cloud/modal/volume";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateVolume, type VolumeHandle, type VolumesClient } from "./CreateVolume.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll } from "./internal.ts";
import type { ModalClient } from "./ModalBindings.ts";
import { ensureVolume, lookupVolume, type VolumeAttributes } from "./Volume.ts";
import { makeReadWriteVolumeClient } from "./VolumeClient.ts";

const handleOf = (attributes: VolumeAttributes, client: ModalClient): VolumeHandle => ({
  ...makeReadWriteVolumeClient(Effect.succeed(attributes.volumeId), client),
  volumeId: Effect.succeed(attributes.volumeId),
  name: attributes.name,
  attributes,
});

/** A volumes client over an environment name resolved per call. */
export const makeVolumesClient = (
  environment: Effect.Effect<string | undefined>,
  client: ModalClient,
): VolumesClient => ({
  getOrCreate: (name) =>
    client(Effect.flatMap(environment, (env) => ensureVolume(name, env))).pipe(
      Effect.map((attributes) => handleOf(attributes, client)),
    ),
  get: (name) =>
    client(Effect.flatMap(environment, (env) => lookupVolume(name, env))).pipe(
      Effect.map((attributes) => (attributes ? handleOf(attributes, client) : undefined)),
    ),
  delete: (name) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const found = yield* lookupVolume(name, env);
        if (!found) return;
        yield* volume
          .deleteVolume({ volumeId: found.volumeId, environmentName: environmentOf(env) })
          .pipe(Effect.catchTag("VolumeNotFound", () => Effect.void));
      }),
    ),
  list: () =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const items = yield* listAll(
          (pagination) =>
            volume
              .listVolume({ environmentName: environmentOf(env), pagination })
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
 * {@link CreateVolume} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Volume
 * @provides Modal.CreateVolume
 */
export const CreateVolumeHttp = Layer.effect(
  CreateVolume,
  makeOpenModalBinding({
    tag: "Modal.CreateVolume",
    make: Effect.fn(function* (client, environment?: Environment) {
      const name = environment ? yield* environment.name : Effect.succeed(undefined);
      return makeVolumesClient(name, client);
    }),
  }),
);
