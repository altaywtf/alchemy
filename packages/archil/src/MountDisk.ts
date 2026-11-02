import { DEFAULT_REGION } from "@distilled.cloud/archil/Credentials";
import * as Binding from "alchemy/Binding";
import type { MountBinding, MountCapability } from "alchemy/Mount";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Disk } from "./Disk.ts";
import { DiskUser } from "./DiskUser.ts";

/**
 * How a mount shares the disk with other clients.
 *
 * - `exclusive` — this client owns writes to the whole disk (local-disk
 *   speed); other clients can still mount `read-only`.
 * - `shared` — many clients; the disk is read-only until a path is checked
 *   out with `archil checkout <path>`.
 * - `conditional` — many writers; writes go to the server unless a path is
 *   checked out (remote-filesystem speed).
 * - `read-only` — no writes.
 */
export type MountMode = "exclusive" | "shared" | "conditional" | "read-only";

export interface MountOptions {
  /**
   * Absolute directory to mount at. Created when missing.
   * @default "/mnt/archil"
   */
  readonly path?: string;
  /** @default "exclusive" */
  readonly mode?: MountMode;
  /** Mount a branch of the disk instead of its root. */
  readonly branch?: string;
  /** Mount only this subdirectory of the disk. */
  readonly subdirectory?: string;
  /**
   * Take ownership of the root from a client that crashed without
   * unmounting. Outstanding writes of that client are lost.
   */
  readonly force?: boolean;
}

/** A run-time mount of a disk named at call time (`MountDisk()`). */
export interface MountAnyOptions extends MountOptions {
  /** Disk id (`dsk-…`) or `<organization>/<name>`. */
  readonly disk: string;
  /** A disk token for that disk, e.g. from `DiskHandle.createToken`. */
  readonly token: string | Redacted.Redacted<string>;
  /** Region the disk lives in. @default the region bound at deploy */
  readonly region?: string;
}

/** `archil mount` or `archil unmount` failed. */
export class MountFailed extends Data.TaggedError("Archil.MountFailed")<{
  readonly disk: string;
  readonly path: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {}

/** The host can't run the Archil client (no process spawner, e.g. a Worker). */
export class MountNotSupported extends Data.TaggedError("Archil.MountNotSupported")<{
  readonly message: string;
}> {}

export type MountError = MountFailed | MountNotSupported;

/** Mounts one deploy-time disk, with a disk user minted for this host. */
export interface MountDiskClient {
  /**
   * Mount the disk for the life of the current scope (typically one
   * request) and return the mount path. Closing the scope flushes and
   * unmounts, releasing any delegations this mount held.
   */
  mount(options?: MountOptions): Effect.Effect<string, MountError, RuntimeContext | Scope.Scope>;
}

/** Mounts any disk the program names at run time. */
export interface MountAnyDiskClient {
  /**
   * Mount a disk with its token for the life of the current scope and
   * return the mount path.
   */
  mount(options: MountAnyOptions): Effect.Effect<string, MountError, RuntimeContext | Scope.Scope>;
}

/**
 * The Archil FUSE client, installed into a host's image. `archil mount`
 * needs `/dev/fuse` and `CAP_SYS_ADMIN`.
 */
export const archilClientCapability: MountCapability = {
  id: "archil",
  install: [
    "RUN (command -v apt-get >/dev/null && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fuse3 && rm -rf /var/lib/apt/lists/*) || (command -v apk >/dev/null && apk add --no-cache ca-certificates curl fuse3)",
    "RUN curl -fsSL https://archil.com/install | sh",
  ],
  requires: { fuse: true },
};

/**
 * Bind the Archil client capability onto the current host. A mount is a
 * host-only attachment (an image layer and a kernel feature), so this is
 * the one place Archil binds directly onto its host.
 */
const bindClientCapability = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (!host) return;
  yield* (
    host as unknown as { bind: (sid: string, data: MountBinding) => Effect.Effect<void> }
  ).bind("Archil.MountDisk", { mounts: [archilClientCapability] });
});

const modeFlags = (mode: MountMode | undefined) =>
  mode === "shared"
    ? ["--shared"]
    : mode === "conditional"
      ? ["--conditional"]
      : mode === "read-only"
        ? ["--read-only"]
        : [];

const run = (
  spawner: ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string | Redacted.Redacted<string>> = {},
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, args, { env, extendEnv: true, shell: false });
    const [exitCode, stderr] = yield* Effect.all(
      [handle.exitCode, handle.stderr.pipe(Stream.decodeText, Stream.mkString)],
      { concurrency: 2 },
    );
    return { exitCode: Number(exitCode), stderr };
  }).pipe(Effect.scoped, Effect.provideService(ChildProcessSpawner, spawner), Effect.orDie);

/** Mount a disk for the life of the ambient scope. */
const mountFor = (
  spawner: Option.Option<ChildProcessSpawner["Service"]>,
  input: {
    readonly disk: string;
    readonly token: Redacted.Redacted<string> | undefined;
    readonly region: string;
    readonly options: MountOptions;
  },
) =>
  Effect.gen(function* () {
    if (Option.isNone(spawner)) {
      return yield* new MountNotSupported({
        message:
          "Archil.MountDisk needs a host that can run processes (a Container, Fly Machine, ECS task, or VM).",
      });
    }
    const path = input.options.path ?? "/mnt/archil";
    const target = input.options.subdirectory
      ? `${input.disk}:/${input.options.subdirectory.replace(/^\//, "")}`
      : input.disk;
    const env: Record<string, string | Redacted.Redacted<string>> = input.token
      ? { ARCHIL_MOUNT_TOKEN: input.token }
      : {};
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        yield* run(spawner.value, "mkdir", ["-p", path]);
        const result = yield* run(
          spawner.value,
          "archil",
          [
            "mount",
            target,
            path,
            "--region",
            input.region,
            ...modeFlags(input.options.mode),
            ...(input.options.branch ? ["--branch", input.options.branch] : []),
            ...(input.options.force ? ["--force"] : []),
          ],
          env,
        );
        if (result.exitCode !== 0) {
          return yield* new MountFailed({ disk: input.disk, path, ...result });
        }
      }),
      () => run(spawner.value, "archil", ["unmount", path], env).pipe(Effect.ignore),
    );
    return path;
  });

export interface MountDiskOptions {
  /**
   * Region of the disks the program mounts with `MountDisk()`. Ignored for
   * `MountDisk(disk)`, which uses the disk's own region.
   * @default "aws-us-east-1"
   */
  region?: string;
}

/**
 * Mount Archil disks on your own machines: a Cloudflare Container, an ECS
 * task, a Fly Machine, or any VM that runs your program. The binding
 * installs the Archil client into the host's image and checks at plan time
 * that the host provides FUSE. Mounts happen at run time, per request, and
 * last as long as the scope that made them.
 *
 * `MountDisk(disk)` mounts one deploy-time disk: it creates a disk user for
 * this host, so Archil itself refuses this host access to any other disk,
 * and the host never holds an API key. `MountDisk()` mounts whatever disk
 * the program names, with a disk token it receives at run time (e.g. from
 * a control Worker's `DiskHandle.createToken`).
 *
 * ### Mounting a Shared Disk
 * **Example:** Read a dataset in a Cloudflare Container
 * ```typescript
 * export default class Indexer extends Cloudflare.Container<Indexer>()(
 *   "Indexer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const dataset = yield* Archil.MountDisk(Dataset);
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.scoped(
 *         Effect.gen(function* () {
 *           const path = yield* dataset.mount({ mode: "read-only" });
 *           return yield* HttpServerResponse.json(yield* fs.readDirectory(path));
 *         }),
 *       ),
 *     };
 *   }).pipe(Effect.provide(Archil.MountDiskLive)),
 * ) {}
 * ```
 *
 * ### Mounting Disks Named at Run Time
 * **Example:** Mount the disk a job names, with its token
 * ```typescript
 * const archil = yield* Archil.MountDisk();
 * const path = yield* archil.mount({ disk: job.diskId, token: job.token, path: "/work" });
 * ```
 *
 * @binding
 * @product Disk
 */
export interface MountDisk extends Binding.Service<
  MountDisk,
  "Archil.MountDisk",
  {
    (disk: Disk): Effect.Effect<MountDiskClient>;
    (disk?: undefined, options?: MountDiskOptions): Effect.Effect<MountAnyDiskClient>;
  } & ((
    disk?: Disk,
    options?: MountDiskOptions,
  ) => Effect.Effect<MountDiskClient & MountAnyDiskClient>)
> {}

export const MountDisk = Binding.Service<MountDisk>("Archil.MountDisk");

/** {@link MountDisk} over the Archil FUSE client. */
export const MountDiskLive = Layer.effect(
  MountDisk,
  Effect.gen(function* () {
    const Users = yield* DiskUser;
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner);
    return Effect.fn(function* (disk?: Disk, options?: MountDiskOptions) {
      yield* bindClientCapability;
      if (disk === undefined) {
        const client: MountAnyDiskClient = {
          mount: (input) =>
            mountFor(spawner, {
              disk: input.disk,
              token: typeof input.token === "string" ? Redacted.make(input.token) : input.token,
              region: input.region ?? options?.region ?? DEFAULT_REGION,
              options: input,
            }),
        };
        return client as MountDiskClient & MountAnyDiskClient;
      }
      const host = yield* Binding.Host;
      const user = yield* Users(`${host?.LogicalId ?? "Script"}${disk.LogicalId}DiskUser`, {
        disk: disk.diskId,
      });
      const token = yield* user.token;
      const diskId = yield* disk.diskId;
      const region = yield* disk.region;
      const client: MountDiskClient = {
        mount: (mountOptions) =>
          Effect.gen(function* () {
            return yield* mountFor(spawner, {
              disk: yield* diskId,
              token: yield* token,
              region: yield* region,
              options: mountOptions ?? {},
            });
          }),
      };
      return client as MountDiskClient & MountAnyDiskClient;
    });
  }),
);
