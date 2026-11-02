import { decodeCbor, encodeCbor } from "@alchemy.run/modal/Cbor";
import { parseDockerfile, validateDockerfile } from "@alchemy.run/modal/ImageBuild";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

describe("Modal Dockerfile lowering", () => {
  it.effect("joins continuation lines and drops comments", () =>
    Effect.sync(() => {
      const instructions = parseDockerfile(
        ["# base", "FROM node:22", "RUN apt-get update && \\", "  apt-get install -y git", ""].join(
          "\n",
        ),
      );
      expect(instructions.map((i) => i.keyword)).toEqual(["FROM", "RUN"]);
      expect(instructions[1]!.args).toBe("apt-get update &&  apt-get install -y git");
      expect(instructions[1]!.line).toBe(3);
    }),
  );

  it.effect("rejects instructions Modal's builder doesn't run, naming the line", () =>
    Effect.gen(function* () {
      const result = yield* validateDockerfile(
        parseDockerfile("FROM debian\nRUN true\nHEALTHCHECK CMD true"),
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.instruction).toBe("HEALTHCHECK");
        expect(result.failure.line).toBe(3);
      }
    }),
  );

  it.effect("accepts a Dockerfile Modal can build", () =>
    Effect.gen(function* () {
      const result = yield* validateDockerfile(
        parseDockerfile(
          "FROM python:3.12\nENV A=1\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt",
        ),
      ).pipe(Effect.result);
      expect(Result.isSuccess(result)).toBe(true);
    }),
  );
});

describe("Modal CBOR codec", () => {
  it.effect("round-trips the values Modal functions exchange", () =>
    Effect.sync(() => {
      const value = [
        ["hello", 42, -7, 1.5, true, false, null, new Uint8Array([1, 2, 3])],
        { nested: { list: [1, 2], n: 4294967296 } },
      ];
      expect(decodeCbor(encodeCbor(value))).toEqual(value);
    }),
  );

  it.effect("encodes the RFC 8949 vectors", () =>
    Effect.sync(() => {
      const hex = (v: unknown) => Buffer.from(encodeCbor(v)).toString("hex");
      expect(hex(0)).toBe("00");
      expect(hex(100)).toBe("1864");
      expect(hex(-1)).toBe("20");
      expect(hex("a")).toBe("6161");
      expect(hex([1, [2, 3]])).toBe("8201820203");
      expect(hex({ a: 1 })).toBe("a1616101");
    }),
  );
});
