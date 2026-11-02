import * as flash from "@distilled.cloud/modal/flash";
import * as server from "@distilled.cloud/modal/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionBinding } from "./FunctionTarget.ts";
import { timestampOf } from "./internal.ts";
import { ReadServer, type ServerReader } from "./ReadServer.ts";
import type { Server } from "./Server.ts";

/**
 * {@link ReadServer} over Modal's API. Binds the deployer's Modal token onto
 * the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Server
 * @provides Modal.ReadServer
 */
export const ReadServerHttp = Layer.effect(
  ReadServer,
  makeFunctionBinding({
    tag: "Modal.ReadServer",
    make: ({ functionId }, client, _server: Server) =>
      Effect.succeed({
        stats: (range) =>
          client(
            Effect.flatMap(functionId, (id) =>
              server.serverGetTimeRangeStats({
                functionId: id,
                since: timestampOf(range.since),
                until: timestampOf(range.until ?? Date.now()),
                containerId: range.containerId,
              }),
            ),
          ),
        requests: (query) =>
          client(
            Effect.flatMap(functionId, (id) =>
              server.fetchServerRequest(
                "limit" in query
                  ? { functionId: id, tail: { count: query.limit } }
                  : {
                      functionId: id,
                      range: {
                        since: timestampOf(query.since),
                        until: timestampOf(query.until ?? Date.now()),
                      },
                    },
              ),
            ).pipe(
              Effect.map((response) =>
                (response.requests ?? []).map((request) => ({
                  route: request.route,
                  timestamp: request.timestamp,
                  containerId: request.containerId,
                  durationSeconds: request.durationSeconds,
                  status: request.status,
                })),
              ),
            ),
          ),
        requestCount: (range) =>
          client(
            Effect.flatMap(functionId, (id) =>
              server.serverCountRequests({
                functionId: id,
                since: timestampOf(range.since),
                until: timestampOf(range.until ?? Date.now()),
                bucketSecs: range.bucketSecs,
              }),
            ),
          ),
        metrics: (range) =>
          client(
            Effect.flatMap(functionId, (id) =>
              server.serverGetMetrics({
                functionId: id,
                since: timestampOf(range.since),
                until: timestampOf(range.until ?? Date.now()),
                bucketSecs: range.bucketSecs,
                groups: range.groups ? [...range.groups] : undefined,
              }),
            ),
          ),
        containers: () =>
          client(
            Effect.flatMap(functionId, (id) => flash.listFlashContainer({ functionId: id })).pipe(
              Effect.map((response) =>
                (response.containers ?? []).map((container) => ({
                  containerId: container.taskId ?? "",
                  host: container.host,
                  port: container.port,
                })),
              ),
            ),
          ),
      } satisfies ServerReader),
  }),
);
