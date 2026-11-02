import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

test.provider(
  "export telemetry to an OTLP endpoint, change it, stop on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const config = yield* stack.deploy(
        Daytona.OrganizationOtelConfig("Telemetry", {
          endpoint: "https://otel.example.com",
          headers: { Authorization: Redacted.make("Bearer test") },
        }),
      );
      expect(config.headerNames).toEqual(["Authorization"]);
      const observed = yield* organizations.getOrganizationOtelConfig({
        organizationId: config.organizationId,
      });
      expect(observed?.endpoint).toEqual("https://otel.example.com");

      yield* stack.deploy(
        Daytona.OrganizationOtelConfig("Telemetry", { endpoint: "https://otel2.example.com" }),
      );
      expect(
        (yield* organizations.getOrganizationOtelConfig({ organizationId: config.organizationId }))
          ?.endpoint,
      ).toEqual("https://otel2.example.com");

      yield* stack.destroy();
      const after = yield* organizations.getOrganizationOtelConfig({
        organizationId: config.organizationId,
      });
      expect(after?.endpoint ?? undefined).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], exclusive: "daytona:organization-otel", timeout: 120_000 },
);
