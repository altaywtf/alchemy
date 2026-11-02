import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import { ReadVolume } from "./ReadVolume.ts";
import type { Volume } from "./Volume.ts";
import { makeReadVolumeClient } from "./VolumeClient.ts";

/**
 * {@link ReadVolume} over Modal's volume API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Volume
 * @provides Modal.ReadVolume
 */
export const ReadVolumeHttp = Layer.effect(
  ReadVolume,
  makeModalBinding({
    tag: "Modal.ReadVolume",
    make: Effect.fn(function* (volume: Volume, client) {
      const volumeId = yield* volume.volumeId;
      return makeReadVolumeClient(volumeId, client);
    }),
  }),
);
