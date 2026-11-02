import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Modal.providers() });

// Needs a Python app deployed with `modal deploy`: MODAL_TEST_FUNCTION_APP=<app>/<function>.
const target = process.env.MODAL_TEST_FUNCTION_APP;

test.provider.skipIf(!target)(
  "set warm containers and restore the original settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const [app, fn] = target!.split("/") as [string, string];
      const scaler = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.FunctionAutoscaler("Scaler", { app, function: fn, maxContainers: 3 });
        }),
      );
      const { autoscalerConfiguration } = yield* functions.functionGetSchedulingParams({
        functionId: scaler.functionId,
      });
      expect(autoscalerConfiguration?.settings?.maxContainers).toBe(3);
      yield* stack.destroy();
      const after = yield* functions.functionGetSchedulingParams({ functionId: scaler.functionId });
      expect(after.autoscalerConfiguration?.settings?.maxContainers).toBe(
        scaler.original.maxContainers,
      );
    }),
  { tags: ["provider:modal", "provider:modal:function", "live"], timeout: 120_000 },
);
