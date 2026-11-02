import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Sandbox } from "./Sandbox.ts";
import type { DaytonaSandbox } from "./SandboxClient.ts";

/**
 * Work with one {@link Sandbox} declared at deploy, from any host: run
 * commands, read and write files, use git, open previews, fork it or
 * snapshot it. Returns the same {@link DaytonaSandbox} handle as
 * {@link CreateSandbox}.
 *
 * The host gets its own Daytona API key with `write:sandboxes` and
 * `delete:sandboxes`; Daytona checks permissions per kind of object, so
 * the key can reach other sandboxes in the organization too.
 *
 * ### Running Commands in a Dev Box
 * **Example:** Pull and test on request
 * ```typescript
 * const devBox = yield* Daytona.ConnectSandbox(DevBox);
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* devBox.startSandbox();
 *     const test = yield* devBox.exec("git pull && pnpm test", { cwd: "/home/daytona/repo" });
 *     return yield* HttpServerResponse.json(test);
 *   }),
 * };
 * ```
 *
 * ### Forking a Dev Box
 * **Example:** Fork it per pull request
 * ```typescript
 * const fork = yield* devBox.forkSandbox({ name: `pr-${number}` });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface ConnectSandbox extends Binding.Service<
  ConnectSandbox,
  "Daytona.ConnectSandbox",
  (sandbox: Sandbox) => Effect.Effect<DaytonaSandbox>
> {}

export const ConnectSandbox = Binding.Service<ConnectSandbox>("Daytona.ConnectSandbox");
