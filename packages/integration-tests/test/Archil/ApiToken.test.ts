import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import { Credentials, controlPlaneUrl } from "@distilled.cloud/archil/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Archil.providers() });

const listed = (tokenId: string) =>
  archil
    .listApiTokens({})
    .pipe(Effect.map(({ data }) => (data.tokens ?? []).find((t) => t.id === tokenId)));

test.provider(
  "API token is minted, usable on its own, replaced on change, and revoked on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* stack.deploy(Archil.ApiToken("Ci", { description: "first" }));
      expect(Redacted.value(token.token)).toMatch(/^key-/);
      expect((yield* listed(token.tokenId))?.name).toBe(token.name);

      // The minted key works with its own credentials, and sees itself.
      const { data } = yield* archil
        .listApiTokens({})
        .pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({ apiKey: token.token, apiBaseUrl: controlPlaneUrl(token.region)! }),
          ),
        );
      expect((data.tokens ?? []).map((t) => t.id)).toContain(token.tokenId);

      const replaced = yield* stack.deploy(Archil.ApiToken("Ci", { description: "second" }));
      expect(replaced.tokenId).not.toBe(token.tokenId);
      expect(yield* listed(token.tokenId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* listed(replaced.tokenId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:apitoken", "live"], timeout: 120_000 },
);
