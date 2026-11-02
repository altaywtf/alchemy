// src/Sandbox.ts
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";

export const Agents = Modal.Environment("Agents", {});

export const Coder = Effect.gen(function* () {
  const agents = yield* Agents;
  return yield* Modal.App("Coder", { environment: agents });
});

export const Node = Effect.gen(function* () {
  const app = yield* Coder;
  return yield* Modal.Image("Node", {
    app,
    image: "node:22-bookworm",
    commands: ["RUN apt-get update && apt-get install -y git"],
  });
});

export const Warm = Effect.gen(function* () {
  const app = yield* Coder;
  const node = yield* Node;
  return yield* Modal.Image("Warm", {
    app,
    from: node,
    run: ["git clone --depth 1 https://github.com/sindresorhus/is /work"],
  });
});
