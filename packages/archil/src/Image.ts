import * as archil from "@distilled.cloud/archil";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { waitForImage } from "./internal/archil.ts";
import type { Providers } from "./Providers.ts";

/** Credentials Archil pulls a private image with. */
export interface ImageRegistryAuth {
  /** Registry username. */
  username: string;
  /** Registry password or access token. */
  password: Redacted.Redacted<string>;
}

export interface ImageProps {
  /**
   * Linux OCI image reference with a `linux/amd64` manifest, e.g.
   * `ghcr.io/acme/agent:1`. Docker shorthand and tags are accepted. Changing
   * it builds a new image.
   */
  source: string;
  /**
   * Credentials for a private registry. Archil uses them for this build
   * only and doesn't store them.
   */
  registryAuth?: ImageRegistryAuth;
}

export interface ImageAttributes {
  /** Image id (64 hex characters); pass it as a sandbox's `image`. */
  imageId: string;
  /** The reference the image was built from. */
  source: string;
  /** The fully qualified reference Archil resolved, e.g. `docker.io/library/node:24`. */
  canonicalSource: string | undefined;
  /** Digest of the image sandboxes boot. */
  digest: string | undefined;
  /** Whether the image came from a private registry. */
  private: boolean;
}

export type Image = Resource<"Archil.Image", ImageProps, ImageAttributes, never, Providers>;

/**
 * A sandbox image, built by Archil from an OCI image in a public or private
 * registry. Sandboxes boot the image's current digest. Public images can
 * also be used directly as a sandbox's `baseImage`; build an `Image` for a
 * private one, or to pin the digest every sandbox boots.
 *
 * Archil has no API to delete an image, so destroying the resource only
 * removes it from Alchemy's state.
 * @see https://docs.archil.com/api-reference/images/build-image
 *
 * ### Building an Image
 * **Example:** From a public image
 * ```typescript
 * export const Base = Archil.Image("Base", { source: "node:24-bookworm" });
 * ```
 *
 * **Example:** From a private registry
 * ```typescript
 * export const Agent = Archil.Image("Agent", {
 *   source: "ghcr.io/acme/agent:1",
 *   registryAuth: { username: "acme-bot", password: Alchemy.Secret("GHCR_TOKEN") },
 * });
 * ```
 *
 * ### Booting Sandboxes from an Image
 * **Example:** Sandboxes created at run time
 * ```typescript
 * const sandboxes = yield* Archil.CreateSandbox(Agent);
 * const sandbox = yield* sandboxes.create({ name: "task-1" });
 * ```
 *
 * @resource
 * @product Image
 */
export const Image = Resource<Image>("Archil.Image");

/** Map an image response to attributes. */
export const toImageAttributes = (image: archil.Image): ImageAttributes => ({
  imageId: image.image_id,
  source: image.source,
  canonicalSource: image.canonical_source,
  digest: image.digest,
  private: image.private,
});

/** Build (or rebuild) an image and wait until it is ready. */
export const buildImage = Effect.fn(function* (props: ImageProps) {
  const { data } = yield* archil.createImage({
    source: props.source,
    registry_auth: props.registryAuth
      ? { username: props.registryAuth.username, password: props.registryAuth.password }
      : undefined,
  });
  return toImageAttributes(yield* waitForImage(data.image_id));
});

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      return {
        stables: ["imageId", "source"],
        // No delete or list API: nuke can't remove images.
        nuke: { skip: true },
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds !== undefined && news.source !== olds.source) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return yield* archil.getImage({ image_id: output.imageId }).pipe(
            Effect.map(({ data }) => toImageAttributes(data)),
            Effect.catchTag("ImageNotFound", () => Effect.undefined),
          );
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — a ready image with the same source is kept; anything
          // else (missing, failed, interrupted) is requested again.
          if (output && output.source === news.source) {
            const observed = yield* archil.getImage({ image_id: output.imageId }).pipe(
              Effect.map(({ data }) => data),
              Effect.catchTag("ImageNotFound", () => Effect.undefined),
            );
            if (observed?.status === "ready") return toImageAttributes(observed);
            if (observed?.status === "building") {
              return toImageAttributes(yield* waitForImage(observed.image_id));
            }
          }
          // Ensure
          yield* session.note(`Building image ${news.source}...`);
          return yield* buildImage(news);
        }),
        // Archil has no image delete API.
        delete: () => Effect.void,
      };
    }),
  );
