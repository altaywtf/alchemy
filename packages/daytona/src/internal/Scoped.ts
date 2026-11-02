import type { Credentials } from "@distilled.cloud/daytona/Credentials";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

/** A generated Daytona operation: callable with its input, and an Effect. */
type Operation<I, O, E> = ((input: I) => Effect.Effect<O, E, Credentials | HttpClient.HttpClient>) &
  Effect.Effect<unknown, never, unknown>;

/** Members a scoped client fills in itself. */
type Fixed = "sandboxIdOrName" | "sandboxId" | "organizationId" | "xDaytonaOrganizationID";

/** One operation, with the fields the client fixes removed from its input. */
export type ScopedOperation<I, O, E> =
  {} extends Omit<I, Fixed>
    ? (input?: Omit<I, Fixed>) => Effect.Effect<O, E, RuntimeContext>
    : (input: Omit<I, Fixed>) => Effect.Effect<O, E, RuntimeContext>;

/**
 * Every operation of a generated service module (`@distilled.cloud/daytona/process`,
 * `/git`, …), re-exposed with Daytona's own parameters and typed errors,
 * minus the fields the client supplies (the sandbox and organization).
 */
export type ScopedModule<M> = {
  readonly [
    K in keyof M as M[K] extends Operation<any, any, any> ? K : never
  ]: M[K] extends Operation<infer I, infer O, infer E> ? ScopedOperation<I, O, E> : never;
};

const isOperation = (
  value: unknown,
): value is (input: unknown) => Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "function" && Effect.isEffect(value);

/**
 * Wrap every operation of `module`: merge `fixed` into each input and run
 * the call through `run` (which supplies credentials and sandbox scope).
 */
export const scopeModule = <M extends object>(
  module: M,
  fixed: Record<string, unknown>,
  run: <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>,
): ScopedModule<M> =>
  Object.fromEntries(
    Object.entries(module)
      .filter(([, value]) => isOperation(value))
      .map(([name, op]) => [
        name,
        (input?: Record<string, unknown>) =>
          run(
            (
              op as (
                input: unknown,
              ) => Effect.Effect<unknown, unknown, Credentials | HttpClient.HttpClient>
            )({
              ...input,
              ...fixed,
            }),
          ),
      ]),
  ) as unknown as ScopedModule<M>;

/** The named operations of a module, as a module-shaped object. */
export const pick = <M extends object, K extends keyof M>(
  module: M,
  names: readonly K[],
): Pick<M, K> => Object.fromEntries(names.map((name) => [name, module[name]])) as Pick<M, K>;
