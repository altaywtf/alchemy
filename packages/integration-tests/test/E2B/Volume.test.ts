import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as volumes from "@distilled.cloud/e2b/volumes";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: E2B.providers() });

const expectVolumeGone = (volumeId: string) =>
  volumes.getVolume({ volumeID: volumeId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (exists) => !exists, times: 10 }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

test.provider(
  "create, redeploy unchanged, and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const volume = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Volume("Cache", {});
        }),
      );
      const observed = yield* volumes.getVolume({ volumeID: volume.volumeId });
      expect(observed.name).toBe(volume.name);

      // Unchanged props: no update, same volume.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Volume("Cache", {});
        }),
      );
      expect(again.volumeId).toBe(volume.volumeId);

      yield* stack.destroy();
      yield* expectVolumeGone(volume.volumeId);
    }),
  { tags: ["provider:e2b", "provider:e2b:volume", "live"], timeout: 120_000 },
);

test.provider(
  "renaming a volume replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stage = yield* Stage;
      const prefix = `alchemy-${stage}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Volume("Named", { name: `${prefix}-volume-a` });
        }),
      );
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Volume("Named", { name: `${prefix}-volume-b` });
        }),
      );
      expect(second.name).toBe(`${prefix}-volume-b`);
      expect(second.volumeId).not.toBe(first.volumeId);
      yield* expectVolumeGone(first.volumeId);

      yield* stack.destroy();
      yield* expectVolumeGone(second.volumeId);
    }),
  { tags: ["provider:e2b", "provider:e2b:volume", "live"], timeout: 120_000 },
);
