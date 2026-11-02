import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ExecDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";

export type { ExecDiskClient, ExecResult, GrepOptions } from "./Clients.ts";

/**
 * Run serverless commands against one disk, and search it, from a Worker,
 * Lambda, or any other host. Each `exec` boots a fresh microVM with the
 * disk mounted at `/mnt/archil`, runs the command to completion (up to five
 * minutes), and shuts down, so you pay only for the call. Files the command
 * writes stay on the disk.
 *
 * The host gets its own Archil API key, created at deploy time and
 * revoked when the stack is destroyed.
 *
 * ### Running Commands
 * **Example:** Count rows in a dataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const dataset = yield* Archil.ExecDisk(Dataset);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* dataset.exec("wc -l /mnt/archil/*.csv");
 *         return HttpServerResponse.text(result.stdout);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.ExecDiskHttp)),
 * ) {}
 * ```
 *
 * ### Searching
 * **Example:** Grep the whole disk in constant time
 * ```typescript
 * const hits = yield* dataset.grep({ pattern: "TODO", directory: "src", recursive: true });
 * ```
 *
 * @binding
 * @product Disk
 */
export interface ExecDisk extends Binding.Service<
  ExecDisk,
  "Archil.ExecDisk",
  (disk: Disk) => Effect.Effect<ExecDiskClient>
> {}

export const ExecDisk = Binding.Service<ExecDisk>("Archil.ExecDisk");
