import * as app from "@distilled.cloud/modal/app";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeModalBinding } from "./BindingHttp.ts";
import { WriteApp, type AppWriter } from "./WriteApp.ts";

/**
 * {@link WriteApp} over Modal's API. Binds the deployer's Modal token onto
 * the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product App
 * @provides Modal.WriteApp
 */
export const WriteAppHttp = Layer.effect(
  WriteApp,
  makeModalBinding({
    tag: "Modal.WriteApp",
    make: Effect.fn(function* (target: App, client) {
      const appId = yield* target.appId;
      return {
        rollback: (options = {}) =>
          client(
            Effect.flatMap(appId, (id) => app.appRollback({ appId: id, version: options.version })),
          ).pipe(Effect.asVoid),
        rollover: () =>
          client(Effect.flatMap(appId, (id) => app.appRollover({ appId: id }))).pipe(Effect.asVoid),
        promote: (version) =>
          client(Effect.flatMap(appId, (id) => app.promoteApp({ appId: id, version }))).pipe(
            Effect.asVoid,
          ),
        stop: () =>
          client(
            Effect.flatMap(appId, (id) =>
              app.stopApp({ appId: id, source: "APP_STOP_SOURCE_CLI" }),
            ),
          ).pipe(Effect.asVoid),
      } satisfies AppWriter;
    }),
  }),
);
