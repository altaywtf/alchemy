import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import * as image from "@distilled.cloud/modal/image";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { CreateImage, type ImageBuildOptions, type ImagesClient } from "./CreateImage.ts";
import { buildImage } from "./ImageBuild.ts";
import type { ModalClient } from "./ModalBindings.ts";

const toBytes = (data: string | Uint8Array) =>
  Effect.sync(() => (typeof data === "string" ? new TextEncoder().encode(data) : data));

/** Build one image from runtime options in `appId`. */
export const buildFromOptions = Effect.fn(function* (appId: string, options: ImageBuildOptions) {
  // Parsed to normalize it; Modal's builder rejects what it can't run.
  // (The plan-time capability check lives with BuildPlan, which imports the
  // bundler and so stays out of runtime bundles.)
  const parsed =
    options.dockerfile !== undefined
      ? yield* DockerfileParser.parse(options.dockerfile)
      : undefined;
  const dockerfile = parsed ? DockerfileParser.renderLines(parsed) : [];
  const extra = options.commands ?? [];
  const commands = [...dockerfile, ...extra];
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
  environment: Effect.Effect<string | undefined> = Effect.succeed(undefined),
): ImagesClient => ({
  fromTag: (tag) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        const found = yield* image
          .imageGetByTag({ tag, environmentName: env ?? "" })
          .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
        return found?.imageId ? { imageId: found.imageId } : undefined;
      }),
    ),
  publish: (target, tag) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        yield* image.publishImage({ imageId: target.imageId, tag, environmentName: env ?? "" });
      }),
    ),
  unpublish: (tag) =>
    client(
      Effect.gen(function* () {
        const env = yield* environment;
        yield* image
          .deleteImageName({ tag: env ? `${env}/${tag}` : tag })
          .pipe(Effect.catchTag("ImageNotFound", () => Effect.void));
      }),
    ),
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
      const appId = yield* app.appId;
      const environment = yield* app.environment;
      return makeImagesClient(appId, client, environment);
    }),
  }),
);
