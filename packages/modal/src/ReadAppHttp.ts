import * as app from "@distilled.cloud/modal/app";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { stringMap, timestampOf } from "./internal.ts";
import { ReadApp, type AppLogFilter, type AppLogLine, type AppReader } from "./ReadApp.ts";

const STREAM = {
  stdout: "FILE_DESCRIPTOR_STDOUT",
  stderr: "FILE_DESCRIPTOR_STDERR",
  info: "FILE_DESCRIPTOR_INFO",
} as const;

const streamOf = (fd: string | undefined): AppLogLine["stream"] =>
  fd === STREAM.stdout
    ? "stdout"
    : fd === STREAM.stderr
      ? "stderr"
      : fd === STREAM.info
        ? "info"
        : undefined;

const filterOf = (filter: AppLogFilter) => ({
  functionId: filter.functionId,
  functionCallId: filter.functionCallId,
  taskId: filter.containerId,
  sandboxId: filter.sandboxId,
  searchText: filter.search,
  source: filter.stream ? STREAM[filter.stream] : undefined,
});

/**
 * {@link ReadApp} over Modal's API. Binds the deployer's Modal token onto the
 * host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product App
 * @provides Modal.ReadApp
 */
export const ReadAppHttp = Layer.effect(
  ReadApp,
  makeModalBinding({
    tag: "Modal.ReadApp",
    make: Effect.fn(function* (target: App, client) {
      const appId = yield* target.appId;
      return {
        logs: (query) =>
          client(
            Effect.flatMap(appId, (id) =>
              app.appFetchLogs({
                appId: id,
                since: timestampOf(query.since),
                until: timestampOf(query.until ?? Date.now()),
                limit: query.limit,
                ...filterOf(query),
              }),
            ).pipe(
              Effect.map((response) =>
                (response.batches ?? []).flatMap((batch) =>
                  (batch.items ?? []).map((line) => ({
                    data: line.data ?? "",
                    timestamp: line.timestamp,
                    stream: streamOf(line.fileDescriptor),
                    functionId: batch.functionId,
                    functionCallId: line.functionCallId,
                    containerId: line.containerId ?? batch.taskId,
                    sandboxId: batch.sandboxId,
                  })),
                ),
              ),
            ),
          ),
        tail: (query = {}) =>
          client(
            Effect.flatMap(appId, (id) =>
              app.appGetLogs({
                appId: id,
                timeout: query.timeout ?? 10,
                lastEntryId: query.cursor,
                functionId: query.functionId,
                functionCallId: query.functionCallId,
                taskId: query.containerId,
                sandboxId: query.sandboxId,
                searchText: query.search,
                fileDescriptor: query.stream ? STREAM[query.stream] : undefined,
              }),
            ).pipe(
              Effect.map(({ items }) => ({
                lines: items.flatMap((batch) =>
                  (batch.items ?? []).map((line) => ({
                    data: line.data ?? "",
                    timestamp: line.timestamp,
                    stream: streamOf(line.fileDescriptor),
                    functionId: batch.functionId,
                    functionCallId: line.functionCallId,
                    containerId: line.containerId ?? batch.taskId,
                    sandboxId: batch.sandboxId,
                  })),
                ),
                cursor: items.findLast((batch) => batch.entryId)?.entryId ?? query.cursor,
              })),
            ),
          ),
        logCount: (query) =>
          client(
            Effect.flatMap(appId, (id) =>
              app.appCountLogs({
                appId: id,
                since: timestampOf(query.since),
                until: timestampOf(query.until ?? Date.now()),
                bucketSecs: query.bucketSecs,
                ...filterOf(query),
              }),
            ),
          ),
        info: () => client(Effect.flatMap(appId, (id) => app.appGetInfo({ appId: id }))),
        lifecycle: () =>
          client(
            Effect.flatMap(appId, (id) => app.appGetLifecycle({ appId: id })).pipe(
              Effect.map((response) => response.lifecycle),
            ),
          ),
        layout: () =>
          client(
            Effect.flatMap(appId, (id) => app.appGetLayout({ appId: id })).pipe(
              Effect.map(({ appLayout }) => ({
                functionIds: stringMap(appLayout?.functionIds),
                classIds: stringMap(appLayout?.classIds),
              })),
            ),
          ),
        deployments: () =>
          client(Effect.flatMap(appId, (id) => app.appDeploymentHistory({ appId: id }))),
      } satisfies AppReader;
    }),
  }),
);
