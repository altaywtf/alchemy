import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import { DaytonaAuth } from "@alchemy.run/daytona/AuthProvider";
import { fromAuthProvider } from "@alchemy.run/daytona/Credentials";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apiKeys from "@distilled.cloud/daytona/api_keys";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { DevBox } from "./fixtures/resources.ts";
import DaytonaWorker from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Daytona.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "DaytonaBindingsStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const devBox = yield* DevBox;
    const worker = yield* DaytonaWorker;
    return { url: worker.url.as<string>(), stage: yield* Stage, devBox: devBox.sandboxId };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const get = (path: string) =>
  Effect.gen(function* () {
    const { url, stage } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}?prefix=${encodeURIComponent(stage)}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* res.json) as any;
  });

/** Out-of-band reads with the deployer's credentials. */
const outOfBand = Effect.provide(fromAuthProvider().pipe(Layer.provide(DaytonaAuth)));

const tags = ["provider:daytona", "provider:cloudflare", "provider:cloudflare:worker", "live"];

describe("CreateSandbox", () => {
  test(
    "creates a sandbox, runs a command, finds and lists it, deletes it",
    Effect.gen(function* () {
      const body = yield* get("/create-sandbox");
      expect(body.echo).toEqual({ exitCode: 0, result: expect.stringContaining("hello") });
      expect(body.size).toBeGreaterThan(0);
      expect(body.found).toBe(true);
      expect(body.listed).toBe(true);
      // The sandbox was deleted when the request's scope closed.
      const { stage } = yield* stack;
      const left = yield* sandboxes
        .getSandbox({ sandboxIdOrName: `alchemy-bindings-${stage}` })
        .pipe(
          Effect.map((s) => s.state),
          Effect.catchTag("SandboxNotFound", () => Effect.succeed("destroyed" as const)),
        );
      expect(["destroyed", "destroying"]).toContain(left);
    }).pipe(outOfBand),
    { tags, timeout: 300_000 },
  );

  test(
    "the Worker's key has only the sandbox permissions",
    Effect.gen(function* () {
      const keys = yield* apiKeys.listApiKeys({});
      const key = keys.find(
        (k) =>
          k.name.includes("DaytonaWorkerSandboxesApiKey") ||
          k.name.includes("daytonaworkersandboxes"),
      );
      expect([...(key?.permissions ?? [])].sort()).toEqual(["delete:sandboxes", "write:sandboxes"]);
    }).pipe(outOfBand),
    { tags, timeout: 60_000 },
  );
});

describe("ConnectSandbox", () => {
  test(
    "runs commands in the deployed sandbox and reads its preview URL",
    Effect.gen(function* () {
      const body = yield* get("/connect-sandbox");
      expect(body.uname.result.trim()).toEqual("Linux");
      expect(body.workDir.dir).toEqual(expect.any(String));
      expect(body.previewUrl).toMatch(/^https:\/\//);
    }),
    { tags, timeout: 300_000 },
  );
});

describe("CreateVolume", () => {
  test(
    "gets or creates a volume by name, refuses names outside the prefix, deletes it",
    Effect.gen(function* () {
      const body = yield* get("/volume");
      expect(body).toEqual({
        same: true,
        state: "ready",
        rejected: "Daytona.NameOutsidePrefix",
        listed: true,
        deleted: true,
      });
    }),
    { tags, timeout: 180_000 },
  );
});

describe("CreateSecret", () => {
  test(
    "puts a secret twice into one secret, finds it, deletes it",
    Effect.gen(function* () {
      const body = yield* get("/secret");
      expect(body).toEqual({ same: true, placeholder: true, found: true, deleted: true });
    }),
    { tags, timeout: 120_000 },
  );
});

describe("CreateSnapshot", () => {
  test(
    "looks snapshots up by name and lists them",
    Effect.gen(function* () {
      const body = yield* get("/snapshot");
      expect(body).toEqual({ missing: true, listed: true });
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadOrganization", () => {
  test(
    "reads shared regions and sandbox classes",
    Effect.gen(function* () {
      const body = yield* get("/organization");
      expect(body.regions).toBeGreaterThan(0);
      expect(body.classes).toBeGreaterThan(0);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadUsage", () => {
  test(
    "reads aggregated usage for the last day",
    Effect.gen(function* () {
      expect((yield* get("/usage")).ok).toBe(true);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ReadAuditLogs", () => {
  test(
    "reads the audit log",
    Effect.gen(function* () {
      // Deploying the stack minted API keys, which the audit log records.
      expect((yield* get("/audit")).items).toBeGreaterThan(0);
    }),
    { tags, timeout: 120_000 },
  );
});
