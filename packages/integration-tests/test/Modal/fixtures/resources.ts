import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const Agents = Modal.Environment("BindingsEnv", {});

export const Coder = Effect.gen(function* () {
  const agents = yield* Agents;
  return yield* Modal.App("BindingsApp", { environment: agents });
});

export const Base = Effect.gen(function* () {
  const app = yield* Coder;
  return yield* Modal.Image("BindingsBase", {
    app,
    image: "debian:bookworm-slim",
    commands: ["RUN echo ready > /ready.txt"],
  });
});

export const Workspace = Effect.gen(function* () {
  const agents = yield* Agents;
  return yield* Modal.Volume("BindingsVolume", { environment: agents });
});

export const Results = Effect.gen(function* () {
  const agents = yield* Agents;
  return yield* Modal.Dict("BindingsDict", { environment: agents });
});

export const Jobs = Effect.gen(function* () {
  const agents = yield* Agents;
  return yield* Modal.Queue("BindingsQueue", { environment: agents });
});

export const Token = Effect.gen(function* () {
  const agents = yield* Agents;
  return yield* Modal.Secret("BindingsSecret", {
    environment: agents,
    env: { TOKEN: Redacted.make("dummy") },
  });
});
