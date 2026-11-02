import * as apiKeys from "@distilled.cloud/daytona/api_keys";
import { Credentials } from "@distilled.cloud/daytona/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** The credentials don't name an organization and the API key reports none. */
export class OrganizationUnknown extends Data.TaggedError("Daytona.OrganizationUnknown")<{}> {
  override get message() {
    return "Could not determine the Daytona organization: set organizationId in the profile or use an organization API key";
  }
}

/**
 * The organization the credentials act on: the profile's `organizationId`,
 * else the organization the API key belongs to.
 */
export const currentOrganizationId = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const config = yield* credentials;
  if (config.organizationId) return config.organizationId;
  const key = yield* apiKeys.getCurrentApiKey({});
  if (!key.organizationId) return yield* new OrganizationUnknown();
  return key.organizationId;
});
