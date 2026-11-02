import { DEFAULT_DOMAIN } from "@distilled.cloud/e2b/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

export const E2B_AUTH_PROVIDER_NAME = "E2B";

export type E2BAuthConfig = StoredAuthConfig;

/**
 * Resolved E2B credentials.
 *
 * `apiKey` is the team API key every control-plane call takes. `accessToken`
 * and `teamId` are only needed to manage the team's API keys
 * (`E2B.ApiKey`): E2B authenticates those endpoints with a personal access
 * token instead of an API key.
 */
export interface E2BResolvedCredentials {
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly accessToken: Redacted.Redacted<string> | undefined;
  readonly teamId: string | undefined;
  readonly domain: string;
  readonly source: { readonly type: E2BAuthConfig["method"] | "env"; readonly details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("E2B_API_KEY");
  const accessToken = yield* getEnvRedacted("E2B_ACCESS_TOKEN");
  if (!apiKey && !accessToken) {
    return yield* AuthError.make({
      message: "E2B CI credentials not found. Set E2B_API_KEY (and E2B_ACCESS_TOKEN for API keys).",
    });
  }
  return {
    apiKey,
    accessToken,
    teamId: yield* getEnv("E2B_TEAM_ID"),
    domain: (yield* getEnv("E2B_DOMAIN")) ?? DEFAULT_DOMAIN,
    source: { type: "env" as const },
  } satisfies E2BResolvedCredentials;
});

const e2bAuth = makeStoredAuthProvider<E2BResolvedCredentials>({
  provider: E2B_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "E2B API key (e2b_…, from https://e2b.dev/dashboard?tab=keys)",
      secret: true,
    },
    {
      name: "accessToken",
      label: "E2B access token (sk_e2b_…), only needed to manage API keys",
      secret: true,
      optional: true,
    },
    {
      name: "teamId",
      label: "E2B team id, only needed to manage API keys",
      optional: true,
    },
    {
      name: "domain",
      label: "E2B domain",
      optional: true,
      placeholder: DEFAULT_DOMAIN,
    },
  ],
  toResolved: (values, source) => ({
    apiKey: storedSecret(values.apiKey),
    accessToken: storedSecret(values.accessToken),
    teamId: storedValueText(values.teamId),
    domain: storedValueText(values.domain) ?? DEFAULT_DOMAIN,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "E2B_API_KEY",
      required: true,
      secret: true,
      description: "Team API key, sent as X-API-Key.",
    },
    {
      name: "E2B_ACCESS_TOKEN",
      required: false,
      secret: true,
      description: "Personal access token; required to manage API keys (E2B.ApiKey).",
    },
    {
      name: "E2B_TEAM_ID",
      required: false,
      description: "Team id sent with the access token.",
    },
    {
      name: "E2B_DOMAIN",
      required: false,
      description: "E2B domain for self-hosted deployments.",
    },
  ],
});

/**
 * Layer that registers the E2B {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Included in `E2B.providers()`
 * so `alchemy profile edit --add E2B` can configure it.
 */
export const E2BAuth = e2bAuth.layer;

/** Schema of E2B's inline static-token values. */
export const E2BStoredCredentials = e2bAuth.storedSchema;
export type E2BStoredCredentials = typeof E2BStoredCredentials.Type;
