import { DEFAULT_API_BASE_URL } from "@distilled.cloud/modal/Credentials";
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

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Modal AuthProvider from inside provider Layers.
 */
export const MODAL_AUTH_PROVIDER_NAME = "Modal";

export type ModalAuthConfig = StoredAuthConfig;

/**
 * Resolved Modal credentials: a workspace token pair, the same one the
 * `modal` CLI stores in `~/.modal.toml` (`modal token new`). Modal tokens
 * act on the whole workspace; there are no narrower scopes.
 */
export interface ModalResolvedCredentials {
  type: "token";
  tokenId: Redacted.Redacted<string>;
  tokenSecret: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: ModalAuthConfig["method"] | "env"; details?: string };
}

const trimmed = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined || Redacted.value(value).trim().length === 0
    ? undefined
    : Redacted.make(Redacted.value(value).trim());

const readEnvironment = Effect.gen(function* () {
  const tokenId = trimmed(yield* getEnvRedacted("MODAL_TOKEN_ID"));
  const tokenSecret = trimmed(yield* getEnvRedacted("MODAL_TOKEN_SECRET"));
  if (tokenId === undefined || tokenSecret === undefined) {
    return yield* AuthError.make({
      message: "Modal CI credentials not found. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
    });
  }
  return {
    type: "token" as const,
    tokenId,
    tokenSecret,
    apiBaseUrl: (yield* getEnv("MODAL_SERVER_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const, details: "MODAL_TOKEN_ID" },
  } satisfies ModalResolvedCredentials;
});

const modalAuth = makeStoredAuthProvider<ModalResolvedCredentials>({
  provider: MODAL_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "tokenId",
      label: "Modal Token ID",
      description:
        "Create one at https://modal.com/settings/tokens, or run `modal token new` and copy token_id from ~/.modal.toml.",
      validate: (value) => (value.trim().startsWith("ak-") ? undefined : "Expected an ak-… id"),
    },
    {
      name: "tokenSecret",
      label: "Modal Token Secret",
      secret: true,
      validate: (value) => (value.trim().startsWith("as-") ? undefined : "Expected an as-… secret"),
    },
  ],
  toResolved: (values, source) => ({
    type: "token",
    tokenId: Redacted.make((storedValueText(values.tokenId) ?? "").trim()),
    tokenSecret: storedSecret(values.tokenSecret) ?? Redacted.make(""),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "MODAL_TOKEN_ID",
      required: true,
      description: "Modal token id (`ak-…`).",
    },
    {
      name: "MODAL_TOKEN_SECRET",
      required: true,
      secret: true,
      description: "Modal token secret (`as-…`).",
    },
    {
      name: "MODAL_SERVER_URL",
      required: false,
      description: "Modal API URL override.",
    },
  ],
});

/**
 * Layer that registers the Modal {@link AuthProvider} into the
 * `AuthProviders` registry when built. Included in `Modal.providers()` so
 * `alchemy profile edit` can configure it.
 */
export const ModalAuth = modalAuth.layer;

/** Schema of Modal's inline stored-token values. */
export const ModalStoredCredentials = modalAuth.storedSchema;
export type ModalStoredCredentials = typeof ModalStoredCredentials.Type;
