import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as runners from "@distilled.cloud/daytona/runners";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

test.provider(
  "register a custom region and a runner, rotate a key, drain the runner, delete both",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (options: { rotate: number; draining: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            const region = yield* Daytona.Region("Home", {
              proxyUrl: "https://proxy.example.com",
              rotate: { proxyApiKey: options.rotate },
            });
            const runner = yield* Daytona.Runner("Box", { region, draining: options.draining });
            return { region, runner };
          }),
        );
      const first = yield* deploy({ rotate: 0, draining: false });
      expect(first.region.proxyApiKey && Redacted.value(first.region.proxyApiKey)).toBeTruthy();
      expect(Redacted.value(first.runner.apiKey)).not.toEqual("");

      const second = yield* deploy({ rotate: 1, draining: true });
      expect(second.region.regionId).toEqual(first.region.regionId);
      expect(Redacted.value(second.region.proxyApiKey!)).not.toEqual(
        Redacted.value(first.region.proxyApiKey!),
      );
      expect((yield* runners.getRunner({ id: first.runner.runnerId })).draining).toBe(true);

      yield* stack.destroy();
      const regions = yield* organizations.listAvailableRegions({});
      expect(regions.some((r) => r.id === first.region.regionId)).toBe(false);
    }),
  { tags: ["provider:daytona", "live"], timeout: 180_000 },
);
