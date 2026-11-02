import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModalBinding } from "./BindingHttp.ts";
import type { Volume } from "./Volume.ts";
import { makeWriteVolumeClient } from "./VolumeClient.ts";
import { WriteVolume } from "./WriteVolume.ts";

/**
 * {@link WriteVolume} over Modal's volume API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Volume
 * @provides Modal.WriteVolume
 */
export const WriteVolumeHttp = Layer.effect(
  WriteVolume,
  makeModalBinding({
    tag: "Modal.WriteVolume",
    make: Effect.fn(function* (volume: Volume, client) {
      const volumeId = yield* volume.volumeId;
      return makeWriteVolumeClient(volumeId, client);
    }),
  }),
);
