import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";

/** Change an App's deployment. */
export interface AppWriter {
  /** Redeploy an earlier version (the previous one by default). */
  rollback(options?: { readonly version?: number }): Effect.Effect<void, any, RuntimeContext>;
  /** Restart every container on the current version, draining the old ones. */
  rollover(): Effect.Effect<void, any, RuntimeContext>;
  /** Put a staged version into production. */
  promote(version: number): Effect.Effect<void, any, RuntimeContext>;
  /** Stop the App: its functions stop serving and its sandboxes terminate. */
  stop(): Effect.Effect<void, any, RuntimeContext>;
}

/**
 * Operate a Modal App from any runtime: roll back a bad version, roll the
 * containers over, promote a staged version, or stop it. The next deploy of
 * the Stack publishes its declared version again.
 *
 * ### Roll back
 * **Example:** From an incident webhook
 * ```typescript
 * const backend = yield* Modal.WriteApp(Backend);
 * yield* backend.rollback();
 * ```
 *
 * @binding
 * @product App
 */
export interface WriteApp extends Binding.Service<
  WriteApp,
  "Modal.WriteApp",
  (app: App) => Effect.Effect<AppWriter>
> {}

export const WriteApp = Binding.Service<WriteApp>("Modal.WriteApp");
