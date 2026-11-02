import { Credentials, CredentialsFromEnv, credentials } from "@distilled.cloud/modal/Credentials";
import { orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/**
 * How a Modal binding reaches Modal from its host.
 *
 * Modal authenticates with a workspace token pair, and the API can't mint a
 * narrower one (tokens act on the whole workspace; service users can't be
 * created through the API). So:
 *
 * - any host (a Cloudflare Worker, a Lambda, a Modal sandbox running an
 *   Effect program): {@link Bind} writes the deployer's token pair into the
 *   host's env (`MODAL_TOKEN_ID`, and `MODAL_TOKEN_SECRET` kept `Redacted`),
 *   and {@link Client} reads it back at runtime;
 * - no host (a script or a deploy-time Action): nothing is bound, and calls
 *   use the deployer's credentials.
 *
 * Isolation between workloads comes from Modal Environments: put the objects
 * a host should touch in their own environment.
 *
 * Import it as a namespace. A binding gets its `bind` from {@link Bind} and
 * its client runner from {@link Client} when its layer is built, then binds
 * behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const client = yield* ModalBindings.Client;
 *   const bind = yield* ModalBindings.Bind;
 *   return Effect.fn(function* (queue: Queue) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* bind`Modal.WriteQueue(${queue})`();
 *     }
 *     const queueId = yield* queue.queueId;
 *     return (value) => client(modalQueue.putQueue({ queueId: yield* queueId, values: [...] }));
 *   });
 * })
 * ```
 */
export const TOKEN_ENV = {
  id: "MODAL_TOKEN_ID",
  secret: "MODAL_TOKEN_SECRET",
  serverUrl: "MODAL_SERVER_URL",
} as const;

/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data?: { readonly env?: Record<string, unknown> }) => Effect.Effect<void>;

/**
 * The `bind` for a binding's layer: yield it while the layer is built, then
 * call it from the returned function behind a literal
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` so the bundler drops it. On a host it
 * writes the deployer's Modal token pair (and `data.env`) into the host's
 * env; with no host it does nothing.
 */
export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const ambient = yield* Effect.serviceOption(Credentials);
  return (_label: TemplateStringsArray, ..._args: unknown[]) =>
    Effect.fn(function* (data?: { readonly env?: Record<string, unknown> }) {
      const host = yield* Binding.Host;
      if (host === undefined) return;
      const runtime = yield* CurrentRuntimeContext;
      if (runtime === undefined) return;
      const resolve = Option.isSome(ambient)
        ? ambient.value
        : yield* Credentials.pipe(Effect.provide(CredentialsFromEnv));
      // Binding initialization can't fail; the engine reports this defect as
      // `CredentialsRequired`.
      const creds = yield* resolve.pipe(orDieCredentialsUnavailable("Modal"));
      yield* runtime.set(TOKEN_ENV.id, Output.literal(Redacted.value(creds.tokenId)));
      yield* runtime.set(TOKEN_ENV.secret, Output.literal(creds.tokenSecret));
      yield* runtime.set(TOKEN_ENV.serverUrl, Output.literal(creds.apiBaseUrl));
      for (const [name, value] of Object.entries(data?.env ?? {})) {
        yield* runtime.set(name, Output.isOutput(value) ? value : Output.literal(value));
      }
    });
});

/** Runs a distilled Modal call with the binding's credentials and an HTTP client. */
export type ModalClient = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, Credentials | HttpClient.HttpClient>>;

/**
 * The runner a binding calls distilled operations through, resolved once
 * when its layer is built: inside a deployed host, the token pair
 * {@link Bind} wrote into its env; otherwise (deploy, scripts, Actions) the
 * ambient Modal credentials, falling back to `MODAL_TOKEN_ID` /
 * `MODAL_TOKEN_SECRET`.
 */
export const Client: Effect.Effect<ModalClient> = Effect.gen(function* () {
  const runtime = yield* CurrentRuntimeContext;
  if (globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined) {
    const tokenId = yield* runtime.get<string>(TOKEN_ENV.id);
    const tokenSecret = yield* runtime.get<string | Redacted.Redacted<string>>(TOKEN_ENV.secret);
    if (tokenId !== undefined && tokenSecret !== undefined) {
      const serverUrl = yield* runtime.get<string>(TOKEN_ENV.serverUrl);
      const layer = Layer.mergeAll(
        credentials({
          tokenId: Redacted.make(tokenId),
          tokenSecret: Redacted.isRedacted(tokenSecret) ? tokenSecret : Redacted.make(tokenSecret),
          apiBaseUrl: serverUrl,
        }),
        FetchHttpClient.layer,
      );
      const context = yield* Layer.build(layer).pipe(Effect.scoped);
      return ((effect) => Effect.provide(effect, context)) as ModalClient;
    }
  }
  const ambientCredentials = yield* Effect.serviceOption(Credentials);
  const ambientHttp = yield* Effect.serviceOption(HttpClient.HttpClient);
  const context = Context.make(
    Credentials,
    Option.isSome(ambientCredentials)
      ? ambientCredentials.value
      : yield* Credentials.pipe(Effect.provide(CredentialsFromEnv)),
  ).pipe(
    Context.add(
      HttpClient.HttpClient,
      Option.isSome(ambientHttp)
        ? ambientHttp.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  );
  return ((effect) => Effect.provide(effect, context)) as ModalClient;
});
