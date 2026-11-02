import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiAccess } from "./ArchilBindings.ts";
import { makeReadDiskClient, makeWriteDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";
import { ReadDisk, type DiskObjectsOptions } from "./ReadDisk.ts";
import { ReadWriteDisk } from "./ReadWriteDisk.ts";
import { WriteDisk } from "./WriteDisk.ts";

const diskRef = Effect.fn(function* (disk: Disk, options: DiskObjectsOptions | undefined) {
  const diskId = yield* disk.diskId;
  return Effect.map(diskId, (id) => ({ disk: id, branch: options?.branch }));
});

/** {@link ReadDisk} over Archil's S3-compatible API, usable from any host. */
export const ReadDiskHttp = Layer.effect(
  ReadDisk,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (disk: Disk, options?: DiskObjectsOptions) {
      return makeReadDiskClient(yield* diskRef(disk, options), yield* access());
    });
  }),
);

/** {@link WriteDisk} over Archil's S3-compatible API, usable from any host. */
export const WriteDiskHttp = Layer.effect(
  WriteDisk,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (disk: Disk, options?: DiskObjectsOptions) {
      return makeWriteDiskClient(yield* diskRef(disk, options), yield* access());
    });
  }),
);

/** {@link ReadWriteDisk} over Archil's S3-compatible API, usable from any host. */
export const ReadWriteDiskHttp = Layer.effect(
  ReadWriteDisk,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (disk: Disk, options?: DiskObjectsOptions) {
      const ref = yield* diskRef(disk, options);
      const authorize = yield* access();
      return { ...makeReadDiskClient(ref, authorize), ...makeWriteDiskClient(ref, authorize) };
    });
  }),
);
