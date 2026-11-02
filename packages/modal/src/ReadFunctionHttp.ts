import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionBinding } from "./FunctionTarget.ts";
import { timestampOf } from "./internal.ts";
import type { FunctionTarget } from "./InvokeFunction.ts";
import { ReadFunction, type FunctionReader } from "./ReadFunction.ts";
import type { Server } from "./Server.ts";

/**
 * {@link ReadFunction} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Function
 * @provides Modal.ReadFunction
 */
export const ReadFunctionHttp = Layer.effect(
  ReadFunction,
  makeFunctionBinding({
    tag: "Modal.ReadFunction",
    make: ({ functionId }, client, _target: FunctionTarget | Server) =>
      Effect.succeed({
        stats: () =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionGetCurrentStats({ functionId: id }),
            ).pipe(
              Effect.map((stats) => ({
                backlog: stats.backlog ?? 0,
                runningInputs: stats.numRunningInputs ?? 0,
                containers: stats.numTotalTasks ?? 0,
                inputHeadroom: stats.inputHeadroom ?? 0,
              })),
            ),
          ),
        timeRangeStats: (range) =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionGetTimeRangeStats({
                functionId: id,
                since: timestampOf(range.since),
                until: timestampOf(range.until ?? Date.now()),
                containerId: range.containerId,
              }),
            ),
          ),
        metrics: (range) =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionGetMetrics({
                functionId: id,
                since: timestampOf(range.since),
                until: timestampOf(range.until ?? Date.now()),
                bucketSecs: range.bucketSecs,
                groups: range.groups ? [...range.groups] : undefined,
              }),
            ),
          ),
        calls: () =>
          client(
            Effect.flatMap(functionId, (id) => functions.listFunctionCall({ functionId: id })).pipe(
              Effect.map((response) => response.functionCalls ?? []),
            ),
          ),
        callCount: (range) =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionCallCount({
                functionId: id,
                since: timestampOf(range.since),
                until: timestampOf(range.until ?? Date.now()),
                bucketSecs: range.bucketSecs,
              }),
            ),
          ),
        callInfo: (call) =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionCallGetInfo({
                functionId: id,
                functionCallId: call.functionCallId,
              }),
            ),
          ),
        autoscaler: () =>
          client(
            Effect.flatMap(functionId, (id) =>
              functions.functionGetSchedulingParams({ functionId: id }),
            ).pipe(Effect.map((response) => response.autoscalerConfiguration?.settings)),
          ),
      } satisfies FunctionReader),
  }),
);
