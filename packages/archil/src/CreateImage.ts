import * as archil from "@distilled.cloud/archil";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiAccess } from "./ArchilBindings.ts";
import { buildImage, toImageAttributes, type ImageAttributes, type ImageProps } from "./Image.ts";
import type { ArchilFailed, ArchilNotReady } from "./internal/archil.ts";

export interface CreateImageClient {
  /**
   * Build an image from an OCI reference and wait until it is ready. Takes
   * the same props as {@link Image}.
   */
  build(
    props: ImageProps,
  ): Effect.Effect<
    ImageAttributes,
    archil.CreateImageError | archil.GetImageError | ArchilFailed | ArchilNotReady,
    RuntimeContext
  >;
  /** An image by id, or `undefined` when it doesn't exist. */
  get(
    imageId: string,
  ): Effect.Effect<ImageAttributes | undefined, archil.GetImageError, RuntimeContext>;
}

/**
 * Build sandbox images at run time, e.g. one per customer repository, with
 * the same props as the deploy-time {@link Image}. Pass the result's
 * `imageId` to `CreateSandbox`.
 *
 * ### Building Images
 * **Example:** An image per tenant
 * ```typescript
 * const images = yield* Archil.CreateImage();
 * const image = yield* images.build({ source: `ghcr.io/acme/${tenant}:latest` });
 * const sandbox = yield* sandboxes.create({ name: tenant, image: image.imageId });
 * ```
 *
 * @binding
 * @product Image
 */
export interface CreateImage extends Binding.Service<
  CreateImage,
  "Archil.CreateImage",
  () => Effect.Effect<CreateImageClient>
> {}

export const CreateImage = Binding.Service<CreateImage>("Archil.CreateImage");

/** {@link CreateImage} over Archil's HTTP API, usable from any host. */
export const CreateImageHttp = Layer.effect(
  CreateImage,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* () {
      const authorize = yield* access();
      return {
        build: (props) => authorize(buildImage(props)),
        get: (imageId) =>
          authorize(
            archil.getImage({ image_id: imageId }).pipe(
              Effect.map(({ data }) => toImageAttributes(data)),
              Effect.catchTag("ImageNotFound", () => Effect.undefined),
            ),
          ),
      } satisfies CreateImageClient;
    });
  }),
);
