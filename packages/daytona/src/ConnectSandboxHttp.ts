import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ConnectSandbox } from "./ConnectSandbox.ts";
import { makeAccess } from "./DaytonaBindings.ts";
import type { Sandbox } from "./Sandbox.ts";
import { makeSandboxClient, type DaytonaSandbox } from "./SandboxClient.ts";

/** {@link ConnectSandbox} over Daytona's HTTP API; works on any host. */
export const ConnectSandboxHttp = Layer.effect(
  ConnectSandbox,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* (sandbox: Sandbox) {
      const { authorize, organizationId } = yield* access(`${sandbox.LogicalId}Connect`, [
        "write:sandboxes",
        "delete:sandboxes",
      ]);
      const sandboxId = yield* sandbox.sandboxId;
      const name = yield* sandbox.name;
      const toolboxProxyUrl = yield* sandbox.toolboxProxyUrl;
      // The handle is built lazily on first use, once the ids resolve at runtime.
      const resolve = Effect.gen(function* () {
        return makeSandboxClient(
          { id: yield* sandboxId, name: yield* name, toolboxProxyUrl: yield* toolboxProxyUrl },
          yield* organizationId,
          authorize,
        );
      });
      return lazyHandle(resolve);
    });
  }),
);

/**
 * A handle whose identity resolves at runtime: each method resolves the
 * sandbox first, then calls through.
 */
const lazyHandle = (resolve: Effect.Effect<DaytonaSandbox, never, any>): DaytonaSandbox => {
  const forward = (path: readonly string[]) =>
    new Proxy(function () {}, {
      get: (_t, key: string) => forward([...path, key]),
      apply: (_t, _this, args: unknown[]) =>
        Effect.flatMap(resolve, (handle) => {
          let target: any = handle;
          for (const segment of path.slice(0, -1)) target = target[segment];
          return target[path.at(-1)!](...args);
        }),
    });
  // A Proxy has no static shape; it forwards every DaytonaSandbox path to
  // the handle resolved at runtime, so the two are the same at the call site.
  return forward([]) as unknown as DaytonaSandbox;
};
