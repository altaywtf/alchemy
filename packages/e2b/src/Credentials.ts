import { ConfigError } from "@distilled.cloud/core/errors";
import { apiBaseUrlFor, Credentials, CredentialsFromEnv } from "@distilled.cloud/e2b/Credentials";
import { lazyCredentials, orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { E2B_AUTH_PROVIDER_NAME, type E2BResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_DOMAIN,
  type Config as CredentialsConfig,
} from "@distilled.cloud/e2b/Credentials";

/** The env var a deployed host reads the team API key from. */
export const E2B_API_KEY_ENV = "E2B_API_KEY";

/**
 * Bind the deployment's team API key onto the current host as
 * `E2B_API_KEY`.
 *
 * E2B API keys have no scopes: a key reaches every sandbox, template,
 * volume and secret in the team. A host that runs an E2B binding gets the
 * key the stack deploys with, kept `Redacted` end to end. Resolved during
 * binding construction so a laptop deploy uses its profile-backed key
 * rather than the process env.
 */
export const bindE2BApiKey = (): Effect.Effect<void, never, Credentials> =>
  Effect.gen(function* () {
    const apiKey = globalThis.__ALCHEMY_RUNTIME__
      ? Redacted.make("")
      : yield* Credentials.pipe(
          Effect.flatMap((resolve) => resolve),
          Effect.flatMap((config) =>
            config.apiKey === undefined
              ? Effect.fail(new ConfigError({ message: "E2B bindings need an E2B API key" }))
              : Effect.succeed(config.apiKey),
          ),
          // Binding construction cannot fail; the engine reports this defect
          // as `CredentialsRequired`.
          orDieCredentialsUnavailable("E2B"),
        );
    yield* Output.named(Output.asOutput(apiKey), E2B_API_KEY_ENV).asEffect().pipe(Effect.asVoid);
  });

/**
 * `Credentials` for the HTTP binding layers.
 *
 * Inside a stack (plan/deploy, or an Action) `providers()` has already
 * resolved the profile-backed `Credentials`, and the binding uses them.
 * Inside a deployed host there is no profile: `bindE2BApiKey` bound the key,
 * which the host exposes as `E2B_API_KEY`. So: reuse the ambient
 * `Credentials` when present, otherwise read the env.
 */
export const CredentialsFromAmbientOrEnv: Layer.Layer<Credentials> = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const ambient = yield* Effect.serviceOption(Credentials);
    if (Option.isSome(ambient)) return ambient.value;
    return yield* Credentials.pipe(Effect.provide(CredentialsFromEnv));
  }),
);

/**
 * Build a `Credentials` layer that resolves E2B credentials via the current
 * Alchemy profile, or directly from environment variables in CI.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<E2BResolvedCredentials, ConfigError>()(E2B_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiKey,
      accessToken: creds.accessToken,
      teamId: creds.teamId,
      domain: creds.domain,
      apiBaseUrl: apiBaseUrlFor(creds.domain),
    })),
  );
