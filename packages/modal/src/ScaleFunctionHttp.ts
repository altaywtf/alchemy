import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionBinding } from "./FunctionTarget.ts";
import type { FunctionTarget } from "./InvokeFunction.ts";
import { ScaleFunction, type FunctionScaler } from "./ScaleFunction.ts";
import type { Server } from "./Server.ts";

/**
 * {@link ScaleFunction} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Function
 * @provides Modal.ScaleFunction
 */
export const ScaleFunctionHttp = Layer.effect(
  ScaleFunction,
  makeFunctionBinding({
    tag: "Modal.ScaleFunction",
    make: ({ functionId }, client, _target: FunctionTarget | Server) =>
      Effect.succeed({
        autoscaler: () =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionGetSchedulingParams({ functionId: id }),
            ).pipe(Effect.map((response) => response.autoscalerConfiguration?.settings)),
          ),
        update: (settings) =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionUpdateSchedulingParams({
                functionId: id,
                settings: {
                  minContainers: settings.minContainers,
                  maxContainers: settings.maxContainers,
                  bufferContainers: settings.bufferContainers,
                  scaleupWindow: settings.scaleupWindow,
                  scaledownWindow: settings.scaledownWindow,
                  targetConcurrencyFloat: settings.targetConcurrency,
                },
              }),
            ).pipe(Effect.map((response) => response.currentSettings)),
          ),
      } satisfies FunctionScaler),
  }),
);
