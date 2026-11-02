import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { Image } from "./Image.ts";
import type { SandboxCreateOptions, SandboxHandle } from "./SandboxClient.ts";

export type {
  ExecOptions,
  ExecResult,
  HeaderReplacement,
  SandboxCreateOptions,
  SandboxFileEntry,
  SandboxHandle,
  SandboxTunnel,
} from "./SandboxClient.ts";

/** A sandbox as `list` reports it. */
export interface SandboxSummary {
  readonly sandboxId: string;
  readonly name: string | undefined;
  readonly createdAt: number | undefined;
  readonly tags: Record<string, string>;
}

/** Create and find sandboxes in one App. Every handle method calls Modal. */
export interface SandboxesClient {
  /** The App sandboxes are created in. */
  readonly appId: Effect.Effect<string>;
  /** Create a sandbox. Modal's own sandbox parameters; the bound image is the default `image`. */
  create(options?: SandboxCreateOptions): Effect.Effect<SandboxHandle, any, RuntimeContext>;
  /** A running sandbox by name, or `undefined`. */
  fromName(name: string): Effect.Effect<SandboxHandle | undefined, any, RuntimeContext>;
  /** A sandbox by id. */
  fromId(sandboxId: string): Effect.Effect<SandboxHandle>;
  /** Running sandboxes of the App, optionally filtered by tags. */
  list(options?: {
    readonly tags?: Record<string, string>;
    readonly includeFinished?: boolean;
  }): Effect.Effect<ReadonlyArray<SandboxSummary>, any, RuntimeContext>;
  /** Start a new sandbox from a memory snapshot (`handle.snapshotMemory()`). */
  restore(
    snapshot: { readonly snapshotId: string },
    options?: { readonly name?: string },
  ): Effect.Effect<SandboxHandle, any, RuntimeContext>;
}

/**
 * Create and drive Modal Sandboxes from any runtime: a Worker, a Lambda, a
 * Durable Object, or a script.
 *
 * Bind it to an App (sandboxes boot from the image you pass to `create`) or
 * to an Image (it is the default image, and sandboxes go in the image's
 * App). A sandbox lives at most 24 hours; to keep work across sandboxes, use
 * a Volume, or snapshot it (`snapshotFilesystem`, `snapshotMemory`) and
 * start the next one from the snapshot.
 *
 * Sandboxes are runtime objects: they aren't in Alchemy state. Stopping the
 * App (destroying the `Modal.App` resource) terminates every sandbox in it.
 *
 * ### Create a sandbox per request
 * **Example:** Run a command and terminate
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Warm } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sandboxes = yield* Modal.CreateSandbox(Warm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sandbox = yield* Effect.acquireRelease(
 *           sandboxes.create({ timeout: "10 minutes" }),
 *           (sandbox) => Effect.ignore(sandbox.terminate()),
 *         );
 *         const test = yield* sandbox.exec(["pnpm", "test"], { workdir: "/work" });
 *         return yield* HttpServerResponse.json(test);
 *       }).pipe(Effect.scoped, Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
 * ) {}
 * ```
 *
 * ### One sandbox per session
 * **Example:** Find it by name, else create it
 * ```typescript
 * const sandbox =
 *   (yield* sandboxes.fromName(`session-${user}`)) ??
 *   (yield* sandboxes.create({ name: `session-${user}`, idleTimeout: "10 minutes" }));
 * ```
 *
 * ### Secrets the sandbox never sees
 * **Example:** Inject an API key into outbound requests
 * ```typescript
 * const sandbox = yield* sandboxes.create({
 *   allowedDomains: ["api.openai.com"],
 *   outboundPolicy: {
 *     headerReplacements: [
 *       { domain: "api.openai.com", secret: openai, headers: { Authorization: "Bearer {OPENAI_API_KEY}" } },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Snapshots
 * **Example:** Save a warmed sandbox and boot the next one from it
 * ```typescript
 * yield* sandbox.exec(["pnpm", "install"], { workdir: "/work" });
 * const image = yield* sandbox.snapshotFilesystem();
 * const next = yield* sandboxes.create({ image });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "Modal.CreateSandbox",
  (target: App | Image) => Effect.Effect<SandboxesClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("Modal.CreateSandbox");
