import type { InlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import * as image from "@distilled.cloud/modal/image";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  buildImage,
  hashImageSpec,
  lowerImageEnvironment,
  type ImageBuildSpec,
} from "./ImageBuild.ts";
import type { Providers } from "./Providers.ts";
import { createSandbox } from "./SandboxClient.ts";

/** A `run` command of a warm-base image exited non-zero. */
export class ImageSetupFailed extends Data.TaggedError("Modal.ImageSetupFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly message: string;
}> {}

export interface ImageProps {
  /** The App the image is built in (`Modal.App`). Images are cached per workspace. */
  app: { readonly appId: string; readonly name?: string; readonly environment?: string };
  /**
   * Start from a registry image (`node:22-slim`, `ghcr.io/org/base:1`).
   * Exclusive with {@link dockerfile} and {@link from}.
   */
  image?: string;
  /**
   * Build from a Dockerfile: a path, or inline content
   * (`Dockerfile.inline\`…\``). Modal's builder runs it: `USER` and `EXPOSE`,
   * `HEALTHCHECK`, `LABEL`, `ONBUILD`, `STOPSIGNAL`, `VOLUME` fail at plan.
   */
  dockerfile?: string | InlineDockerfile;
  /** Build context for the Dockerfile's COPY/ADD sources. */
  context?: string;
  /** Start from another `Modal.Image` (a warm base built on a base). */
  from?: { readonly imageId: string };
  /** Dockerfile lines appended to the build (`"RUN pip install pandas"`). */
  commands?: string[];
  /**
   * Shell commands run in a sandbox booted from the built image; its
   * filesystem is then snapshotted into this image. Use it for setup that
   * needs network or secrets at runtime (cloning a repo, installing
   * dependencies), the deploy-time warm base sandboxes fork from.
   */
  run?: string[];
  /** Secrets the build (and `run`) sees as environment variables. */
  secrets?: Array<{ readonly secretId: string }>;
  /** Pull a private base image with credentials stored in a `Modal.Secret`. */
  registry?: {
    readonly type: "aws" | "gcp" | "static";
    readonly secret: { readonly secretId: string };
  };
  /** Run build steps on a GPU (`"A10G"`, `"H100"`). */
  gpu?: string;
  /** Pin Modal's image builder version (`"2025.06"`). */
  builderVersion?: string;
}

export interface ImageAttributes {
  /** Image ID (`im-…`): pass it as `image` when creating sandboxes. */
  imageId: string;
  /** The App the image was built in; `CreateSandbox(image)` creates sandboxes there. */
  appId: string;
  /** Name of that App (for finding its sandboxes by name). */
  appName: string | undefined;
  /** Environment of that App. */
  environment: string | undefined;
  /** Content hash of the build inputs; a change rebuilds. */
  hash: string;
}

/**
 * A Modal Image: a container image built by Modal's own builder (not
 * Docker), from a registry image, a Dockerfile, or another Modal Image plus
 * commands. Sandboxes boot from it.
 *
 * With `run`, the image becomes a warm base: Alchemy boots a sandbox from the
 * built image, runs the commands, snapshots its filesystem, and terminates
 * it. Sandboxes created from the result start with the repo cloned and
 * dependencies installed. Runtime snapshots (`sandbox.snapshotFilesystem()`)
 * are images too and work anywhere an image does.
 *
 * Modal builds remotely: deploying needs no local Docker.
 *
 * ### Building an Image
 * **Example:** From a registry image with extra packages
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 *
 * export const Coder = Modal.App("Coder", {});
 * export const Node = Effect.gen(function* () {
 *   const app = yield* Coder;
 *   return yield* Modal.Image("Node", {
 *     app,
 *     image: "node:22-bookworm",
 *     commands: ["RUN apt-get update && apt-get install -y git ripgrep"],
 *   });
 * });
 * ```
 *
 * **Example:** From an inline Dockerfile
 * ```typescript
 * import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 *
 * export const Coder = Modal.App("Coder", {});
 * export const Python = Effect.gen(function* () {
 *   const app = yield* Coder;
 *   return yield* Modal.Image("Python", {
 *     app,
 *     dockerfile: Dockerfile.inline`
 *       FROM python:3.12-slim
 *       RUN pip install pandas
 *     `,
 *   });
 * });
 * ```
 *
 * ### A warm base to fork from
 * **Example:** Clone and install once, start every sandbox from it
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 *
 * export const Coder = Modal.App("Coder", {});
 * export const Warm = Effect.gen(function* () {
 *   const app = yield* Coder;
 *   const node = yield* Modal.Image("Node", { app, image: "node:22-bookworm" });
 *   return yield* Modal.Image("Warm", {
 *     app,
 *     from: node,
 *     run: [
 *       "git clone https://github.com/alchemy-run/alchemy /work",
 *       "cd /work && corepack enable && pnpm install",
 *     ],
 *   });
 * });
 * ```
 *
 * @resource
 * @product Image
 */
export const Image = Resource<Image>("Modal.Image");

export type Image = Resource<"Modal.Image", ImageProps, ImageAttributes, never, Providers>;

const idOf = <K extends string>(value: unknown, key: K): string | undefined =>
  typeof value === "object" && value !== null && key in value
    ? ((value as Record<K, unknown>)[key] as string | undefined)
    : undefined;

/** The build spec for an Image's props (Dockerfile lowered, context collected). */
const specOf = Effect.fn(function* (news: ImageProps) {
  const base: ImageBuildSpec = yield* lowerImageEnvironment({
    image: news.image,
    dockerfile: news.dockerfile,
    context: news.context,
    commands: news.commands,
  });
  const fromId = idOf(news.from, "imageId");
  return {
    ...base,
    ...(fromId !== undefined ? { dockerTag: undefined, baseImageId: fromId } : {}),
    secretIds: (news.secrets ?? []).flatMap((s) => idOf(s, "secretId") ?? []),
    registry: news.registry
      ? { authType: news.registry.type, secretId: idOf(news.registry.secret, "secretId") ?? "" }
      : undefined,
    gpu: news.gpu,
    builderVersion: news.builderVersion,
  } satisfies ImageBuildSpec;
});

const hashOf = Effect.fn(function* (news: ImageProps) {
  const spec = yield* specOf(news);
  const hash = yield* hashImageSpec(spec);
  return news.run ? `${hash}:${JSON.stringify(news.run)}` : hash;
});

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      return {
        stables: [],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          // A changed build input (including files under `context`) is a new image.
          const hash = yield* hashOf(news);
          return hash !== output.hash ? ({ action: "update" } as const) : undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* image
            .imageFromId({ imageId: output.imageId })
            .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
          return found?.imageId ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const appId = idOf(news.app, "appId") ?? "";
          const hash = yield* hashOf(news);
          // Observe: an image built from the same inputs still exists.
          if (output !== undefined && output.hash === hash && output.appId === appId) {
            const found = yield* image
              .imageFromId({ imageId: output.imageId })
              .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
            if (found?.imageId) return output;
          }
          // Ensure: Modal content-addresses builds, so this is a no-op for
          // inputs it has built before.
          const spec = yield* specOf(news);
          let imageId = yield* buildImage(appId, spec, { note: session.note });
          // Warm base: run setup in a sandbox and snapshot its filesystem.
          if (news.run && news.run.length > 0) {
            yield* session.note(`Running setup for image ${imageId}...`);
            const box = yield* createSandbox(
              { appId },
              {
                image: { imageId },
                secrets: spec.secretIds?.map((secretId) => ({ secretId })),
                timeout: "1 hour",
              },
            );
            const snapshot = yield* Effect.gen(function* () {
              for (const command of news.run ?? []) {
                const result = yield* box.exec(["sh", "-lc", command]);
                if (result.exitCode !== 0) {
                  return yield* new ImageSetupFailed({
                    command,
                    exitCode: result.exitCode,
                    message: `\`${command}\` exited ${result.exitCode}: ${result.stderr.slice(-2000)}`,
                  });
                }
              }
              return yield* box.snapshotFilesystem("5 minutes");
            }).pipe(Effect.ensuring(Effect.ignore(box.terminate())));
            imageId = snapshot.imageId;
          }
          return {
            imageId,
            appId,
            appName: idOf(news.app, "name"),
            environment: idOf(news.app, "environment"),
            hash,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* image
            .deleteImage({ imageId: output.imageId })
            .pipe(Effect.catchTag("ImageNotFound", () => Effect.void));
        }),
      };
    }),
  );
