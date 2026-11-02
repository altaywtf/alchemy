import * as zlib from "node:zlib";
import { filesHash, tarGzip } from "@alchemy.run/e2b/internal/BuildContext";
import { lowerDockerfile } from "@alchemy.run/e2b/internal/Dockerfile";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

const tags = ["unit", "provider:e2b"];

describe("lowerDockerfile", () => {
  it.effect(
    "lowers RUN, COPY, ENV, WORKDIR, USER and CMD to E2B steps",
    () =>
      Effect.gen(function* () {
        const lowered = yield* lowerDockerfile(
          [
            "ARG NODE=22",
            "FROM node:${NODE}-bookworm",
            "# a comment",
            'ENV A=1 B="two words"',
            "RUN apt-get update && \\",
            "    apt-get install -y git",
            "COPY --chown=user:user src/ /app/src/",
            "WORKDIR /app",
            "USER user",
            "EXPOSE 3000",
            'CMD ["node", "server.js"]',
          ].join("\n"),
        );
        expect(lowered.fromImage).toBe("node:22-bookworm");
        expect(lowered.startCmd).toBe("node server.js");
        expect(lowered.steps).toEqual([
          { type: "USER", args: ["root"] },
          { type: "WORKDIR", args: ["/"] },
          { type: "ENV", args: ["A", "1", "B", "two words"] },
          { type: "RUN", args: ["apt-get update &&     apt-get install -y git"] },
          { type: "COPY", args: ["src/", "/app/src/", "user:user", ""] },
          { type: "WORKDIR", args: ["/app"] },
          { type: "USER", args: ["user"] },
        ]);
      }),
    { tags },
  );

  it.effect(
    "ends as `user` in /home/user like E2B, unless the Dockerfile says otherwise",
    () =>
      Effect.gen(function* () {
        const lowered = yield* lowerDockerfile("FROM ubuntu:24.04\nRUN echo hi\n");
        expect(lowered.steps.slice(-2)).toEqual([
          { type: "USER", args: ["user"] },
          { type: "WORKDIR", args: ["/home/user"] },
        ]);
      }),
    { tags },
  );

  it.effect(
    "build args override ARG defaults",
    () =>
      Effect.gen(function* () {
        const lowered = yield* lowerDockerfile("ARG V=1\nFROM img:${V}\n", { V: "2" });
        expect(lowered.fromImage).toBe("img:2");
      }),
    { tags },
  );

  for (const [name, dockerfile, message] of [
    ["multi-stage builds", "FROM a AS b\nFROM c\n", "single-stage"],
    ["COPY --from", "FROM a\nCOPY --from=b /x /y\n", "multi-stage"],
    ["ADD from a URL", "FROM a\nADD https://example.com/x /x\n", "URL"],
    ["sources outside the context", "FROM a\nCOPY ../secret /x\n", "inside the build context"],
    ["a missing FROM", "RUN echo hi\n", "FROM"],
  ] as const) {
    it.effect(
      `rejects ${name} at plan time`,
      () =>
        Effect.gen(function* () {
          const error = yield* lowerDockerfile(dockerfile).pipe(Effect.flip);
          expect(error._tag).toBe("E2B.UnsupportedDockerfileInstruction");
          expect(error.message).toContain(message);
        }),
      { tags },
    );
  }
});

describe("build context", () => {
  const file = (path: string, text: string) => ({
    path,
    mode: 0o644,
    contents: new TextEncoder().encode(text),
  });

  it(
    "hashes contents, so a changed file changes the hash",
    () => {
      const a = filesHash("src", "/app", [file("src/a.txt", "one")]);
      const b = filesHash("src", "/app", [file("src/a.txt", "two")]);
      expect(a).toHaveLength(64);
      expect(a).not.toBe(b);
      expect(filesHash("src", "/app", [file("src/a.txt", "one")])).toBe(a);
    },
    { tags },
  );

  it.effect(
    "packs files into a gzipped ustar archive, long paths included",
    () =>
      Effect.gen(function* () {
        const long = `${"d/".repeat(60)}f.txt`;
        const archive = yield* tarGzip([file("a.txt", "hello"), file(long, "deep")]);
        const tar = zlib.gunzipSync(archive);
        expect(tar.subarray(257, 262).toString()).toBe("ustar");
        expect(tar.subarray(0, 5).toString()).toBe("a.txt");
        expect(tar.includes(Buffer.from(`path=${long}`))).toBe(true);
        expect(tar.length % 512).toBe(0);
      }),
    { tags },
  );
});
