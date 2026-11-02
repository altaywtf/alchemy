import { createHash } from "node:crypto";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as snapshots from "@distilled.cloud/daytona/snapshots";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { createInternalLabels } from "./internal/Labels.ts";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import { runCommand } from "./internal/Process.ts";
import { waitForState, waitUntilGone } from "./internal/Wait.ts";
import type { Providers } from "./Providers.ts";

type Ref<T> = T | Effect.Effect<T, never, Providers>;

/** A snapshot, by name. Accepts a `Daytona.Snapshot` or `{ name }`. */
export type SnapshotRef = { readonly name: string };

/** A private registry. Accepts a `Daytona.Registry` or `{ registryId }`. */
export type SnapshotRegistry = { readonly registryId: string };

/** Inline Dockerfile content; `Dockerfile.inline` from `@alchemy.run/docker` produces one. */
export interface InlineDockerfile {
  readonly content: string;
}

export type GpuType = snapshots.GpuType;

export interface SnapshotProps {
  /**
   * Snapshot name, unique in the organization. Sandboxes are created from
   * it by name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * An image to pull, with an explicit tag or digest (Daytona rejects
   * `latest`, `lts` and `stable`). Pass a {@link Registry} as `registry`
   * for private images. Exclusive with `dockerfile` and `from`.
   */
  image?: string;
  /**
   * A Dockerfile Daytona builds on its own builders: a path, or inline
   * content (`Dockerfile.inline`). No local Docker is needed. Changing it
   * replaces the snapshot. Exclusive with `image` and `from`.
   */
  dockerfile?: string | InlineDockerfile;
  /**
   * Build a warm base from another snapshot: start a sandbox from `from`,
   * run `run` in it, and capture its filesystem as this snapshot. Use it to
   * bake a cloned repository and installed dependencies into the snapshot
   * sandboxes fork from. Exclusive with `image` and `dockerfile`.
   */
  from?: Ref<SnapshotRef>;
  /**
   * Shell commands run in order in the `from` sandbox before it is
   * captured. A non-zero exit fails the deploy.
   */
  run?: string[];
  /** Private registry to pull `image` (or a Dockerfile's base) from. */
  registry?: Ref<SnapshotRegistry>;
  /** The command a sandbox from this snapshot runs. */
  entrypoint?: string[];
  /** vCPUs for sandboxes from this snapshot. */
  cpu?: number;
  /** Memory in GiB. */
  memory?: number;
  /** Disk in GiB. */
  disk?: number;
  /** GPUs per sandbox. Billed per hour while a sandbox runs. */
  gpu?: number;
  /** Acceptable GPU types, in order of preference. */
  gpuType?: GpuType[];
  /** Region to build the snapshot in. */
  regionId?: string;
  /** Sandbox class (`container`, `linux-vm`, …). Dockerfile builds need `container`. */
  sandboxClass?: snapshots.SandboxClass;
}

export interface SnapshotAttributes {
  /** Snapshot ID. */
  snapshotId: string;
  /** Snapshot name; what sandboxes are created from. */
  name: string;
  /** State (`active` once usable). */
  state: snapshots.SnapshotState;
  /** The pulled or built image. */
  imageName: string | undefined;
  /** Internal image reference. */
  ref: string | undefined;
  /** vCPUs. */
  cpu: number;
  /** Memory in GiB. */
  memory: number;
  /** Disk in GiB. */
  disk: number;
  /** GPUs. */
  gpu: number;
  /** The sandbox this snapshot was captured from, for `from` snapshots. */
  sourceSandboxId: string | undefined;
  /** Hash of everything the snapshot was built from. */
  buildHash: string;
}

export type Snapshot = Resource<
  "Daytona.Snapshot",
  SnapshotProps,
  SnapshotAttributes,
  never,
  Providers
>;

/**
 * A Daytona snapshot: the image sandboxes boot from, with its default
 * size. Pull one from a registry, build one from a Dockerfile on
 * Daytona's builders, or capture one from a sandbox after running setup
 * commands in it (a warm base to fork from).
 *
 * Snapshots are immutable: changing what one is built from replaces it.
 * Daytona deactivates a snapshot after two weeks without use; deploy
 * reactivates it.
 * @see https://www.daytona.io/docs/en/snapshots/
 *
 * ### Pulling an Image
 * **Example:** A public image with a size
 * ```typescript
 * export const Node = Daytona.Snapshot("Node", {
 *   image: "node:22-bookworm",
 *   cpu: 2,
 *   memory: 4,
 *   disk: 10,
 * });
 * ```
 *
 * ### Building from a Dockerfile
 * **Example:** An inline Dockerfile built by Daytona
 * ```typescript
 * export const Base = Daytona.Snapshot("Base", {
 *   dockerfile: Dockerfile.inline`
 *     FROM node:22-bookworm
 *     RUN apt-get update && apt-get install -y git ripgrep
 *   `,
 *   cpu: 2,
 *   memory: 4,
 * });
 * ```
 *
 * ### A Warm Base to Fork From
 * **Example:** Clone and install once, then start every sandbox from it
 * ```typescript
 * export const Warm = Daytona.Snapshot("Warm", {
 *   from: Base,
 *   run: [
 *     "git clone https://github.com/alchemy-run/alchemy /home/daytona/alchemy",
 *     "cd /home/daytona/alchemy && pnpm install",
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Snapshot
 */
export const Snapshot = Resource<Snapshot>("Daytona.Snapshot");

/** The snapshot props name more than one of `image`, `dockerfile` and `from`, or none. */
export class SnapshotSourceInvalid extends Data.TaggedError("Daytona.SnapshotSourceInvalid")<{
  readonly message: string;
}> {}

/** A Dockerfile copies local files, which Daytona can't build without the build context. */
export class SnapshotContextUnsupported extends Data.TaggedError(
  "Daytona.SnapshotContextUnsupported",
)<{
  readonly line: string;
}> {
  override get message() {
    return `Daytona snapshot Dockerfiles can't copy local files yet (${this.line.trim()}). Build the image elsewhere and pass it as \`image\`, or fetch the files in a RUN step.`;
  }
}

/** A `run` command exited non-zero while building a snapshot from a sandbox. */
export class SnapshotRunFailed extends Data.TaggedError("Daytona.SnapshotRunFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}> {
  override get message() {
    return `\`${this.command}\` exited ${this.exitCode} while building the snapshot:\n${this.output.slice(-2000)}`;
  }
}

/** The image has no tag, or a moving one Daytona rejects. */
export class SnapshotImageTagInvalid extends Data.TaggedError("Daytona.SnapshotImageTagInvalid")<{
  readonly image: string;
}> {
  override get message() {
    return `Daytona needs an image with a fixed tag or digest; got ${this.image} (latest, lts and stable are rejected)`;
  }
}

const sha256 = (value: unknown) =>
  Effect.sync(() => createHash("sha256").update(JSON.stringify(value)).digest("hex"));

const refName = <T extends { readonly name: string }>(ref: Ref<T> | undefined) =>
  ref === undefined
    ? Effect.undefined
    : Effect.isEffect(ref)
      ? Effect.map(ref, (r) => r.name)
      : Effect.succeed(ref.name);

const checkImage = (image: string) => {
  const last = image.split("/").at(-1) ?? image;
  const tag = image.includes("@")
    ? "digest"
    : last.includes(":")
      ? last.split(":").at(-1)!
      : undefined;
  return tag === undefined || ["latest", "lts", "stable"].includes(tag)
    ? Effect.fail(new SnapshotImageTagInvalid({ image }))
    : Effect.void;
};

/** Dockerfile content, with local COPY/ADD rejected (no context upload yet). */
const dockerfileContent = Effect.fn(function* (dockerfile: string | InlineDockerfile) {
  let content: string;
  if (typeof dockerfile === "string") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    content = yield* fs.readFileString(path.resolve(dockerfile));
  } else {
    content = dockerfile.content;
  }
  for (const line of content.split("\n")) {
    const match = /^\s*(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!match) continue;
    const args = match[2]!.split(/\s+/);
    const fromStage = args.some((a) => a.startsWith("--from="));
    const remote = args
      .filter((a) => !a.startsWith("--"))
      .slice(0, -1)
      .every((a) => /^https?:\/\//.test(a));
    if (!fromStage && !remote) return yield* new SnapshotContextUnsupported({ line });
  }
  return content;
});

/** What the snapshot is built from, resolved; its hash decides rebuilds. */
const resolveSource = Effect.fn(function* (news: SnapshotProps) {
  const sources = [news.image, news.dockerfile, news.from].filter((s) => s !== undefined);
  if (sources.length !== 1) {
    return yield* new SnapshotSourceInvalid({
      message: "Daytona.Snapshot takes exactly one of `image`, `dockerfile` or `from`",
    });
  }
  if (news.image !== undefined) yield* checkImage(news.image);
  const dockerfile =
    news.dockerfile !== undefined ? yield* dockerfileContent(news.dockerfile) : undefined;
  const from = yield* refName(news.from);
  const source = {
    image: news.image,
    dockerfile,
    from,
    run: news.run ?? [],
    entrypoint: news.entrypoint,
    cpu: news.cpu,
    memory: news.memory,
    disk: news.disk,
    gpu: news.gpu,
    gpuType: news.gpuType,
    regionId: news.regionId,
    sandboxClass: news.sandboxClass,
  };
  return { ...source, buildHash: yield* sha256(source) };
});

export const toSnapshotAttributes = (
  s: snapshots.SnapshotDto,
  buildHash: string,
): SnapshotAttributes => ({
  snapshotId: s.id,
  name: s.name,
  state: s.state,
  imageName: s.imageName,
  ref: s.ref,
  cpu: s.cpu,
  memory: s.mem,
  disk: s.disk,
  gpu: s.gpu,
  sourceSandboxId: s.sourceSandboxId ?? undefined,
  buildHash,
});

export const getSnapshot = (idOrName: string) =>
  snapshots
    .getSnapshot({ id: idOrName })
    .pipe(Effect.catchTag("SnapshotNotFound", () => Effect.undefined));

/** Wait for a snapshot to become usable, reactivating it when Daytona has deactivated it. */
export const waitForSnapshot = Effect.fn(function* (idOrName: string) {
  const current = yield* snapshots.getSnapshot({ id: idOrName });
  if (current.state === "inactive") yield* snapshots.activateSnapshot({ id: current.id });
  return yield* waitForState({
    kind: "snapshot",
    id: idOrName,
    observe: snapshots.getSnapshot({ id: idOrName }),
    want: ["active"],
    fail: ["error", "build_failed"],
    reason: (s) => s.errorReason,
    budget: "30 minutes",
  });
});

export const deleteSnapshot = Effect.fn(function* (idOrName: string) {
  yield* snapshots
    .removeSnapshot({ id: idOrName })
    .pipe(Effect.catchTag("SnapshotNotFound", () => Effect.void));
  yield* waitUntilGone(
    "snapshot",
    idOrName,
    getSnapshot(idOrName).pipe(Effect.map((s) => s !== undefined)),
    "5 minutes",
  );
});

/**
 * Start a sandbox from `from`, run the commands in it and capture it as a
 * snapshot named `name`. The build sandbox is deleted whatever happens, and
 * deletes itself after an hour if this process dies first.
 */
export const captureSnapshot = Effect.fn(function* (input: {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly run: readonly string[];
  readonly note: (message: string) => Effect.Effect<void>;
}) {
  const labels = yield* createInternalLabels(input.id);
  const build = yield* Effect.acquireRelease(
    sandboxes.createSandbox({
      name: `${input.name}-build`.slice(0, 63),
      snapshot: input.from,
      labels: { ...labels, "alchemy.role": "snapshot-build" },
      autoDeleteInterval: 60,
    }),
    (sandbox) =>
      sandboxes.deleteSandbox({ sandboxIdOrName: sandbox.id }).pipe(
        Effect.catchTag("SandboxNotFound", () => Effect.void),
        Effect.ignore,
      ),
  );
  const started = yield* waitForState({
    kind: "sandbox",
    id: build.id,
    observe: sandboxes.getSandbox({ sandboxIdOrName: build.id }),
    want: ["started"],
    fail: ["error", "build_failed", "destroyed"],
    reason: (s) => s.errorReason,
  });
  for (const command of input.run) {
    yield* input.note(`Running \`${command}\` in the snapshot build sandbox...`);
    const result = yield* runCommand(started.id, started.toolboxProxyUrl, {
      command,
      timeout: 1800,
    });
    if ((result.exitCode ?? 0) !== 0) {
      return yield* new SnapshotRunFailed({
        command,
        exitCode: result.exitCode ?? -1,
        output: result.result,
      });
    }
  }
  yield* input.note(`Capturing snapshot ${input.name}...`);
  yield* sandboxes.createSandboxSnapshot({ sandboxIdOrName: started.id, name: input.name });
  return yield* waitForSnapshot(input.name);
}, Effect.scoped);

export const SnapshotProvider = () =>
  Provider.effect(
    Snapshot,
    Effect.succeed({
      stables: ["snapshotId"],
      list: Effect.fn(function* () {
        const all = yield* snapshots.getAllSnapshots.items({}).pipe(Stream.runCollect);
        return Array.from(all)
          .filter((s) => !s.general)
          .map((s) => toSnapshotAttributes(s, ""));
      }),
      diff: Effect.fn(function* ({ id, news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const name = yield* resolveName(
          id,
          news.name,
          news.name === undefined ? output.name : undefined,
        );
        const { buildHash } = yield* resolveSource(news);
        if (name !== output.name || buildHash !== output.buildHash) {
          // Sandboxes reference snapshots by name, so a pinned name is freed first.
          return { action: "replace", deleteFirst: name === output.name } as const;
        }
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const found =
          (output ? yield* getSnapshot(output.snapshotId) : undefined) ??
          (yield* getSnapshot(yield* resolveName(id, olds?.name, output?.name)));
        if (found === undefined) return undefined;
        const attrs = toSnapshotAttributes(found, output?.buildHash ?? "");
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output, session }) {
        const name = yield* resolveName(id, news.name, output?.name);
        const source = yield* resolveSource(news);

        // Observe
        const current = yield* getSnapshot(output?.snapshotId ?? name);
        if (current !== undefined && current.name === name) {
          // Ensure usable: reactivate a snapshot Daytona deactivated after
          // two weeks unused, and wait out a build already in flight.
          const ready = current.state === "active" ? current : yield* waitForSnapshot(current.id);
          return toSnapshotAttributes(ready, output?.buildHash ?? source.buildHash);
        }

        // Ensure
        if (source.from !== undefined) {
          const captured = yield* captureSnapshot({
            id,
            name,
            from: source.from,
            run: source.run,
            note: session.note,
          });
          return toSnapshotAttributes(captured, source.buildHash);
        }
        yield* session.note(
          source.dockerfile !== undefined
            ? `Building snapshot ${name} on Daytona...`
            : `Pulling ${source.image} into snapshot ${name}...`,
        );
        yield* snapshots
          .createSnapshot({
            name,
            imageName: source.image,
            buildInfo:
              source.dockerfile !== undefined
                ? { dockerfileContent: source.dockerfile }
                : undefined,
            entrypoint: source.entrypoint,
            cpu: source.cpu,
            memory: source.memory,
            disk: source.disk,
            gpu: source.gpu,
            gpuType: source.gpuType,
            regionId: source.regionId,
            sandboxClass: source.sandboxClass,
          })
          .pipe(Effect.catchTag("SnapshotAlreadyExists", () => Effect.void));
        return toSnapshotAttributes(yield* waitForSnapshot(name), source.buildHash);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* deleteSnapshot(output.snapshotId);
      }),
    }),
  );
