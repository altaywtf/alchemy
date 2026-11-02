import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Dataset } from "./resources.ts";

export class MountContainer extends Cloudflare.Container<MountContainer, {}>()("ArchilMount") {}

/** A Container that mounts the Dataset disk per request with its own disk user. */
export default MountContainer.make(
  { main: import.meta.url, image: "node:24-bookworm", runtime: "node" },
  Effect.gen(function* () {
    const dataset = yield* Archil.MountDisk(Dataset);
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const key = new URL(request.url, "http://container").searchParams.get("key") ?? "";
          const path = yield* dataset.mount({ path: "/mnt/dataset", mode: "read-only" });
          return HttpServerResponse.text(yield* fs.readFileString(`${path}/${key}`));
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Archil.MountDiskLive)),
);
