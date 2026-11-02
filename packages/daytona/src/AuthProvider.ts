import { DEFAULT_API_BASE_URL } from "@distilled.cloud/daytona/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const DAYTONA_AUTH_PROVIDER_NAME = "Daytona";

export type DaytonaAuthConfig = StoredAuthConfig;

/** Resolved Daytona credentials: an organization API key and the API root. */
export interface DaytonaResolvedCredentials {
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  /** Only needed with a user JWT; an API key already belongs to one organization. */
  organizationId?: string;
  source: { type: DaytonaAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("DAYTONA_API_KEY");
  if (!apiKey) {
    return yield* AuthError.make({
      message: "Daytona CI credentials not found. Set DAYTONA_API_KEY.",
    });
  }
  return {
    apiKey,
    apiBaseUrl: (yield* getEnv("DAYTONA_API_URL")) ?? DEFAULT_API_BASE_URL,
    organizationId: yield* getEnv("DAYTONA_ORGANIZATION_ID"),
    source: { type: "env" as const },
  } satisfies DaytonaResolvedCredentials;
});

const daytonaAuth = makeStoredAuthProvider<DaytonaResolvedCredentials>({
  provider: DAYTONA_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "Daytona API key (https://app.daytona.io/dashboard/keys)",
      secret: true,
    },
    {
      name: "apiBaseUrl",
      label: "Daytona API URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
    {
      name: "organizationId",
      label: "Daytona organization ID (only for user tokens)",
      optional: true,
    },
  ],
  toResolved: (values, source) => ({
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    organizationId: storedValueText(values.organizationId),
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "DAYTONA_API_KEY",
      required: true,
      secret: true,
      description: "Organization API key.",
    },
    {
      name: "DAYTONA_API_URL",
      required: false,
      description: "API root for a self-hosted Daytona.",
    },
    {
      name: "DAYTONA_ORGANIZATION_ID",
      required: false,
      description: "Organization id; only needed with a user token.",
    },
  ],
});

/**
 * Layer that registers the Daytona {@link AuthProvider} into the
 * {@link AuthProviders} registry when built, so `alchemy profile edit` can
 * configure it.
 */
export const DaytonaAuth = daytonaAuth.layer;

/** Schema of Daytona's stored credential values. */
export const DaytonaStoredCredentials = daytonaAuth.storedSchema;
export type DaytonaStoredCredentials = typeof DaytonaStoredCredentials.Type;
