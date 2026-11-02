import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Archil.providers() });

test.provider(
  "image builds from a public reference and rebuilds when the source changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const image = yield* stack.deploy(Archil.Image("Base", { source: "alpine:3.20" }));
      expect(image.imageId).toMatch(/^[0-9a-f]{64}$/);
      expect(image.private).toBe(false);
      expect((yield* archil.getImage({ image_id: image.imageId })).data.status).toBe("ready");

      // Unchanged props keep the image.
      const same = yield* stack.deploy(Archil.Image("Base", { source: "alpine:3.20" }));
      expect(same.imageId).toBe(image.imageId);

      const next = yield* stack.deploy(Archil.Image("Base", { source: "alpine:3.21" }));
      expect(next.source).toBe("alpine:3.21");
      expect(next.digest).not.toBe(image.digest);

      yield* stack.destroy();
    }),
  { tags: ["provider:archil", "provider:archil:image", "live"], timeout: 180_000 },
);
