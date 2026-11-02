import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Archil.providers() });

const users = (diskId: string) =>
  archil.getDisk({ id: diskId }).pipe(
    Effect.map(({ data }) => (data.authorizedUsers ?? []).map((u) => u.identifier)),
    Effect.catchTag("DiskNotFound", () => Effect.succeed([] as Array<string | undefined>)),
  );

test.provider(
  "disk user mints a token for one disk, re-mints on rename, and is revoked on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (nickname?: string) =>
        Effect.gen(function* () {
          const disk = yield* Archil.Disk("Shared", {});
          const user = yield* Archil.DiskUser("Reader", { disk: disk.diskId, nickname });
          return { disk, user };
        });

      const { disk, user } = yield* stack.deploy(app());
      expect(user.type).toBe("token");
      expect(user.token).toBeDefined();
      expect(yield* users(disk.diskId)).toContain(user.identifier);

      const renamed = yield* stack.deploy(app("reader-2"));
      expect(renamed.user.identifier).not.toBe(user.identifier);
      const current = yield* users(disk.diskId);
      expect(current).toContain(renamed.user.identifier);
      expect(current).not.toContain(user.identifier);

      // Destroying only the user leaves the disk with no extra users.
      yield* stack.deploy(Archil.Disk("Shared", {}));
      expect(yield* users(disk.diskId)).not.toContain(renamed.user.identifier);

      yield* stack.destroy();
    }),
  { tags: ["provider:archil", "provider:archil:diskuser", "live"], timeout: 180_000 },
);
