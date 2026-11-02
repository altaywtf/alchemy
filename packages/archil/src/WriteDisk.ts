import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { WriteDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";
import type { DiskObjectsOptions } from "./ReadDisk.ts";

export type { WriteDiskClient } from "./Clients.ts";

/**
 * Write a disk's files as objects over Archil's S3-compatible API: put,
 * append, copy, delete. A write that conflicts with a mounted client's
 * write delegation fails with `ObjectConflict`; `delegations` and
 * `revokeDelegation` reclaim paths a crashed client still holds.
 *
 * ### Writing Files
 * **Example:** Append events to a log on a disk
 * ```typescript
 * const files = yield* Archil.WriteDisk(Dataset);
 * yield* files.append("events.ndjson", JSON.stringify(event) + "\n");
 * ```
 *
 * ### Recovering From a Crashed Mount
 * **Example:** Revoke orphaned delegations
 * ```typescript
 * for (const d of yield* files.delegations()) {
 *   if (d.isOrphaned) yield* files.revokeDelegation(d);
 * }
 * ```
 *
 * @binding
 * @product Disk
 */
export interface WriteDisk extends Binding.Service<
  WriteDisk,
  "Archil.WriteDisk",
  (disk: Disk, options?: DiskObjectsOptions) => Effect.Effect<WriteDiskClient>
> {}

export const WriteDisk = Binding.Service<WriteDisk>("Archil.WriteDisk");
