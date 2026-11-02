import * as image from "@distilled.cloud/modal/image";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { CreateImage, type ImageBuildOptions, type ImagesClient } from "./CreateImage.ts";
import { buildImage, parseDockerfile, validateDockerfile } from "./ImageBuild.ts";
import type { ModalClient } from "./ModalBindings.ts";

const toBytes = (data: string | Uint8Array) =>
  Effect.sync(() => (typeof data === "string" ? new TextEncoder().encode(data) : data));

/** Build one image from runtime options in `appId`. */
export const buildFromOptions = Effect.fn(function* (appId: string, options: ImageBuildOptions) {
  const dockerfile = options.dockerfile ? parseDockerfile(options.dockerfile) : [];
  const commands = [...dockerfile.map((i) => i.text), ...(options.commands ?? [])];
  yield* validateDockerfile(parseDockerfile(commands.join("\n")));
  const contextFiles = yield* Effect.forEach(
    Object.entries(options.files ?? {}),
    ([filename, data]) => Effect.map(toBytes(data), (bytes) => ({ filename, data: bytes })),
  );
  const imageId = yield* buildImage(appId, {
    dockerTag: options.dockerfile
      ? undefined
      : options.from
        ? undefined
        : (options.image ?? "debian:bookworm-slim"),
    baseImageId: options.dockerfile ? undefined : options.from?.imageId,
    commands,
    contextFiles,
    secretIds: options.secrets?.map((s) => s.secretId),
    gpu: options.gpu,
    forceBuild: options.force,
  });
  return { imageId };
});

/** An images client over an app id resolved per call. */
export const makeImagesClient = (
  appId: Effect.Effect<string>,
  client: ModalClient,
): ImagesClient => ({
  build: (options) => client(Effect.flatMap(appId, (id) => buildFromOptions(id, options))),
  delete: (target) =>
    client(
      image.deleteImage({ imageId: target.imageId }).pipe(
        Effect.catchTag("ImageNotFound", () => Effect.void),
        Effect.asVoid,
      ),
    ),
});

/**
 * {@link CreateImage} over Modal's API. Binds the deployer's Modal token onto
 * the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Image
 * @provides Modal.CreateImage
 */
export const CreateImageHttp = Layer.effect(
  CreateImage,
  makeModalBinding({
    tag: "Modal.CreateImage",
    make: Effect.fn(function* (app: App, client) {
      return makeImagesClient(yield* app.appId, client);
    }),
  }),
);
