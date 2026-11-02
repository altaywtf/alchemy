import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";
import { environmentOf } from "./internal.ts";
import type { FunctionRef, FunctionTarget } from "./InvokeFunction.ts";
import * as ModalBindings from "./ModalBindings.ts";

/*
 * Shared scaffolding for bindings on a function (a `Modal.Function` or
 * `Modal.Server` of the Stack, or a deployed function by name). NOT exported
 * from `index.ts`.
 */

export const isFunctionRef = (target: unknown): target is FunctionRef =>
  typeof target === "object" &&
  target !== null &&
  typeof (target as FunctionRef).app === "string" &&
  typeof (target as FunctionRef).function === "string";

/** A resolved target: its function id (looked up once) and the class method, if any. */
export interface ResolvedFunction {
  readonly functionId: Effect.Effect<string, any, any>;
  readonly method: string | undefined;
}

/**
 * Resolve a target in the construction phase. A resource of the Stack
 * carries its id; a name is looked up on first use and cached (the id only
 * changes when the App is redeployed).
 */
export const resolveFunction = Effect.fn(function* (
  target: FunctionTarget | { readonly functionId: unknown },
) {
  if (!isFunctionRef(target)) {
    const functionId = yield* (
      target as { readonly functionId: Effect.Effect<Effect.Effect<string>> }
    ).functionId;
    return { functionId, method: undefined } satisfies ResolvedFunction;
  }
  const [tag, method] = target.function.includes(".")
    ? [`${target.function.split(".")[0]}.*`, target.function.split(".").slice(1).join(".")]
    : [target.function, undefined];
  let cached: string | undefined;
  const functionId = Effect.suspend(() =>
    cached !== undefined
      ? Effect.succeed(cached)
      : functions
          .getFunction({
            appName: target.app,
            objectTag: tag,
            environmentName: environmentOf(target.environment),
          })
          .pipe(
            Effect.map((response) => response.functionId ?? ""),
            Effect.tap((id) => Effect.sync(() => (cached = id))),
          ),
  );
  return { functionId, method } satisfies ResolvedFunction;
});

/**
 * A binding layer over a function target: binds the Modal token pair onto
 * the host (deploy only), resolves the target, and builds the client.
 */
export const makeFunctionBinding = <Target, Client>(options: {
  readonly tag: string;
  readonly make: (
    resolved: ResolvedFunction,
    client: ModalBindings.ModalClient,
    target: Target,
  ) => Effect.Effect<Client>;
}) =>
  Effect.gen(function* () {
    const client = yield* ModalBindings.Client;
    const bind = yield* ModalBindings.Bind;
    return Effect.fn(options.tag)(function* (target: Target) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        if (isFunctionRef(target)) yield* bind`${options.tag}`();
        else yield* bind`${options.tag}(${target})`();
      }
      const resolved = yield* resolveFunction(target as FunctionTarget);
      return yield* options.make(resolved, client, target);
    });
  });
