import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

test.provider(
  "change the default queue timeout and restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const settings = yield* stack.deploy(
        Daytona.OrganizationSettings("Settings", { defaultQueueTimeout: "90 seconds" }),
      );
      expect(settings.defaultQueueTimeout).toEqual(90);
      const before = settings.original.defaultQueueTimeout;
      expect(
        (yield* organizations.getOrganization({ organizationId: settings.organizationId }))
          .defaultQueueTimeout,
      ).toEqual(90);

      yield* stack.destroy();
      const restored = yield* organizations.getOrganization({
        organizationId: settings.organizationId,
      });
      expect(restored.defaultQueueTimeout).toEqual(before);
    }),
  {
    tags: ["provider:daytona", "live"],
    exclusive: "daytona:organization-settings",
    timeout: 120_000,
  },
);
