import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as ModalBindings from "./ModalBindings.ts";

/**
 * Shared scaffolding for Modal's HTTP bindings. NOT exported from `index.ts`.
 *
 * At layer build it resolves the client runner ({@link ModalBindings.Client})
 * and the host `bind`. Per bound resource it binds the token pair onto the
 * host (deploy only) and builds the client: `make` runs in the construction
 * phase, so it reads the resource's attribute accessors there
 * (`yield* volume.volumeId`) and yields them per call.
 */
export const makeModalBinding = <Res extends ResourceLike, Client>(options: {
  /** Fully qualified binding tag, e.g. `Modal.WriteQueue`. */
  readonly tag: string;
  readonly make: (resource: Res, client: ModalBindings.ModalClient) => Effect.Effect<Client>;
}) =>
  Effect.gen(function* () {
    const client = yield* ModalBindings.Client;
    const bind = yield* ModalBindings.Bind;
    return Effect.fn(options.tag)(function* (resource: Res) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`();
      }
      return yield* options.make(resource, client);
    });
  });

/**
 * Shared scaffolding for open bindings (no bound resource): binds the token
 * pair onto the host once and builds the client.
 */
export const makeOpenModalBinding = <Args extends ReadonlyArray<unknown>, Client>(options: {
  readonly tag: string;
  readonly make: (client: ModalBindings.ModalClient, ...args: Args) => Effect.Effect<Client>;
}) =>
  Effect.gen(function* () {
    const client = yield* ModalBindings.Client;
    const bind = yield* ModalBindings.Bind;
    return Effect.fn(options.tag)(function* (...args: Args) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`();
      }
      return yield* options.make(client, ...args);
    });
  });

/** A stored value isn't JSON (e.g. a pickled value written by Modal's Python client). */
export class ModalValueNotJson extends Data.TaggedError("Modal.ValueNotJson")<{
  readonly message: string;
}> {}

/** JSON-encode a value as base64 bytes, Modal's `bytes` wire form. */
export const encodeJson = (value: unknown) =>
  Effect.sync(() => Buffer.from(JSON.stringify(value), "utf8").toString("base64"));

/** Decode base64 JSON bytes written by {@link encodeJson} or any JSON writer. */
export const decodeJson = <A = unknown>(data: string) =>
  Effect.try({
    try: () => JSON.parse(Buffer.from(data, "base64").toString("utf8")) as A,
    catch: () =>
      new ModalValueNotJson({
        message:
          "The stored value isn't JSON. Values written by Modal's Python client are pickled; write them as JSON (bytes of json.dumps) to share them.",
      }),
  });
