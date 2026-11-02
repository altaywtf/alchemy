import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import { ReadWriteVolume } from "./ReadWriteVolume.ts";
import type { Volume } from "./Volume.ts";
import { makeReadWriteVolumeClient } from "./VolumeClient.ts";

/**
 * {@link ReadWriteVolume} over Modal's volume API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Volume
 * @provides Modal.ReadWriteVolume
 */
export const ReadWriteVolumeHttp = Layer.effect(
  ReadWriteVolume,
  makeModalBinding({
    tag: "Modal.ReadWriteVolume",
    make: Effect.fn(function* (volume: Volume, client) {
      const volumeId = yield* volume.volumeId;
      return makeReadWriteVolumeClient(volumeId, client);
    }),
  }),
);
