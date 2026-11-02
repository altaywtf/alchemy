import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/** The deployed function a client calls. */
export interface FunctionRef {
  /** Name of the deployed App (`modal deploy` / `modal.App("…")`). */
  readonly app: string;
  /** Function name in the App (`"embed"`), or `"Class.method"` for a class method. */
  readonly function: string;
  /** Environment the App is deployed in. @default the workspace default */
  readonly environment?: string;
}

/** The function raised, or Modal failed the call. */
export class FunctionCallFailed extends Data.TaggedError("Modal.FunctionCallFailed")<{
  readonly status: string;
  readonly message: string;
  readonly traceback?: string;
}> {}

/** The call didn't finish within its timeout. */
export class FunctionCallTimeout extends Data.TaggedError("Modal.FunctionCallTimeout")<{
  readonly functionCallId: string;
  readonly message: string;
}> {}

/** Call one deployed Python function. Arguments and results travel as CBOR. */
export interface FunctionClient {
  /** Call the function and wait for its result. */
  call<A = unknown>(
    args?: ReadonlyArray<unknown>,
    kwargs?: Record<string, unknown>,
    options?: { readonly timeout?: number | string },
  ): Effect.Effect<A, any, RuntimeContext>;
  /** Start a call without waiting; read it later with {@link result}. */
  spawn(
    args?: ReadonlyArray<unknown>,
    kwargs?: Record<string, unknown>,
  ): Effect.Effect<{ readonly functionCallId: string }, any, RuntimeContext>;
  /** The result of a spawned call, waiting up to `timeout`. */
  result<A = unknown>(
    call: { readonly functionCallId: string },
    options?: { readonly timeout?: number | string },
  ): Effect.Effect<A, any, RuntimeContext>;
  /** Cancel a spawned call. */
  cancel(call: { readonly functionCallId: string }): Effect.Effect<void, any, RuntimeContext>;
}

/**
 * Call a Python function deployed with Modal (`modal deploy`) from any
 * runtime: a Worker, a Lambda, a Durable Object. Alchemy doesn't deploy
 * Python functions; it calls the ones you have.
 *
 * Arguments and results are CBOR (Modal's cross-language format): numbers,
 * strings, bytes, lists, dicts, booleans and `None`. The function needs no
 * changes.
 *
 * ### Call a function
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const embed = yield* Modal.InvokeFunction({ app: "inference", function: "embed" });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const vector = yield* embed.call<number[]>(["hello world"]);
 *         return yield* HttpServerResponse.json({ dims: vector.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.InvokeFunctionHttp)),
 * ) {}
 * ```
 *
 * ### Fire and forget
 * **Example:** Spawn, then read the result later
 * ```typescript
 * const job = yield* train.spawn([], { epochs: 3 });
 * const metrics = yield* train.result(job, { timeout: "30 minutes" });
 * ```
 *
 * @binding
 * @product Function
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "Modal.InvokeFunction",
  (target: FunctionRef) => Effect.Effect<FunctionClient>
> {}

export const InvokeFunction = Binding.Service<InvokeFunction>("Modal.InvokeFunction");
