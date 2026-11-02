import * as functions from "@distilled.cloud/modal/functions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { decodeCbor, encodeCbor } from "./Cbor.ts";
import { environmentOf, seconds } from "./internal.ts";
import {
  FunctionCallFailed,
  FunctionCallTimeout,
  InvokeFunction,
  type FunctionClient,
  type FunctionRef,
} from "./InvokeFunction.ts";
import type { ModalClient } from "./ModalBindings.ts";

const encodeArgs = (args: ReadonlyArray<unknown>, kwargs: Record<string, unknown>) =>
  Effect.try({
    try: () => Buffer.from(encodeCbor([args, kwargs])).toString("base64"),
    catch: (cause) =>
      new FunctionCallFailed({
        status: "INVALID_ARGUMENTS",
        message: `Arguments aren't CBOR-encodable: ${String(cause)}`,
      }),
  });

const decodeResult = (data: string | undefined) =>
  Effect.try({
    try: () => (data ? decodeCbor(new Uint8Array(Buffer.from(data, "base64"))) : null),
    catch: (cause) =>
      new FunctionCallFailed({
        status: "INVALID_RESULT",
        message: `The result isn't CBOR (return plain values, or set the function's serialization): ${String(cause)}`,
      }),
  });

/** A function client over `ref`; the function id is looked up once, on first use. */
export const makeFunctionClient = (ref: FunctionRef, client: ModalClient): FunctionClient => {
  const [name, method] = ref.function.includes(".")
    ? [`${ref.function.split(".")[0]}.*`, ref.function.split(".").slice(1).join(".")]
    : [ref.function, undefined];
  // Looked up on first use and kept: the id changes only when the app is redeployed.
  let cachedId: string | undefined;
  const functionId = Effect.suspend(() =>
    cachedId !== undefined
      ? Effect.succeed(cachedId)
      : functions
          .getFunction({
            appName: ref.app,
            objectTag: name,
            environmentName: environmentOf(ref.environment),
          })
          .pipe(
            Effect.map((response) => response.functionId ?? ""),
            Effect.tap((id) => Effect.sync(() => (cachedId = id))),
          ),
  );

  const start = Effect.fn(function* (
    args: ReadonlyArray<unknown>,
    kwargs: Record<string, unknown>,
    invocation: "FUNCTION_CALL_INVOCATION_TYPE_SYNC" | "FUNCTION_CALL_INVOCATION_TYPE_ASYNC",
  ) {
    const id = yield* functionId;
    const encoded = yield* encodeArgs(args, kwargs);
    const response = yield* functions.functionMap({
      functionId: id,
      functionCallType: "FUNCTION_CALL_TYPE_UNARY",
      functionCallInvocationType: invocation,
      returnExceptions: false,
      pipelinedInputs: [
        {
          idx: 0,
          input: {
            args: encoded,
            dataFormat: "DATA_FORMAT_CBOR",
            methodName: method,
            finalInput: true,
          },
        },
      ],
    });
    return response.functionCallId ?? "";
  });

  const result = Effect.fn(function* (
    functionCallId: string,
    timeout: number | string | undefined,
  ) {
    const budget = seconds(timeout) ?? 300;
    const rounds = Math.max(1, Math.ceil(budget / 55));
    for (let round = 0; round < rounds; round++) {
      const { outputs } = yield* functions.getFunctionOutputs({
        functionCallId,
        maxValues: 1,
        timeout: Math.min(55, budget),
        lastEntryId: "0-0",
        clearOnSuccess: true,
      });
      const output = outputs?.[0];
      if (!output?.result) continue;
      if (output.result.status !== "GENERIC_STATUS_SUCCESS") {
        return yield* new FunctionCallFailed({
          status: output.result.status ?? "GENERIC_STATUS_UNSPECIFIED",
          message: output.result.exception || `Function call ${functionCallId} failed`,
          traceback: output.result.traceback,
        });
      }
      return yield* decodeResult(output.result.data);
    }
    return yield* new FunctionCallTimeout({
      functionCallId,
      message: `Function call ${functionCallId} didn't finish within ${budget} seconds`,
    });
  });

  return {
    call: <A>(
      args: ReadonlyArray<unknown> = [],
      kwargs: Record<string, unknown> = {},
      options: { readonly timeout?: number | string } = {},
    ) =>
      client(
        start(args, kwargs, "FUNCTION_CALL_INVOCATION_TYPE_SYNC").pipe(
          Effect.flatMap((id) => result(id, options.timeout)),
          // CBOR results are untyped; the caller names the shape it expects.
          Effect.map((value) => value as A),
        ),
      ),
    spawn: (args = [], kwargs = {}) =>
      client(
        start(args, kwargs, "FUNCTION_CALL_INVOCATION_TYPE_ASYNC").pipe(
          Effect.map((functionCallId) => ({ functionCallId })),
        ),
      ),
    result: <A>(
      call: { readonly functionCallId: string },
      options: { readonly timeout?: number | string } = {},
    ) =>
      client(result(call.functionCallId, options.timeout)).pipe(Effect.map((value) => value as A)),
    cancel: (call) =>
      client(
        functions.cancelFunctionCall({ functionCallId: call.functionCallId }).pipe(
          Effect.catchTag("FunctionCallNotFound", () => Effect.void),
          Effect.asVoid,
        ),
      ),
  };
};

/**
 * {@link InvokeFunction} over Modal's API. Binds the deployer's Modal token
 * onto the host; Modal tokens act on the whole workspace.
 *
 * @layer
 * @product Function
 * @provides Modal.InvokeFunction
 */
export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  makeOpenModalBinding({
    tag: "Modal.InvokeFunction",
    make: (client, ref: FunctionRef) => Effect.succeed(makeFunctionClient(ref, client)),
  }),
);
