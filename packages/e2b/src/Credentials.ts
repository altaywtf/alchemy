import { ConfigError } from "@distilled.cloud/core/errors";
import { apiBaseUrlFor, Credentials } from "@distilled.cloud/e2b/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { E2B_AUTH_PROVIDER_NAME, type E2BResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_DOMAIN,
  type Config as CredentialsConfig,
} from "@distilled.cloud/e2b/Credentials";

/**
 * Build a `Credentials` layer that resolves E2B credentials via the current
 * Alchemy profile, or directly from environment variables in CI.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<E2BResolvedCredentials, ConfigError>()(E2B_AUTH_PROVIDER_NAME, (creds) => ({
      ...(creds.apiKey === undefined ? {} : { apiKey: creds.apiKey }),
      ...(creds.accessToken === undefined ? {} : { accessToken: creds.accessToken }),
      ...(creds.teamId === undefined ? {} : { teamId: creds.teamId }),
      domain: creds.domain,
      apiBaseUrl: apiBaseUrlFor(creds.domain),
    })),
  );
