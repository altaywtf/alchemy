import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

test.provider(
  "create an organization, change its default region, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(Daytona.Organization("Team", { defaultRegionId: "us" }));
      expect(created.defaultRegionId).toEqual("us");
      const updated = yield* stack.deploy(Daytona.Organization("Team", { defaultRegionId: "eu" }));
      expect(updated.organizationId).toEqual(created.organizationId);
      yield* stack.destroy();
      const gone = yield* organizations
        .getOrganization({ organizationId: created.organizationId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("OrganizationNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
