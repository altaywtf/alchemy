/**
 * Lowers a Dockerfile to E2B template build steps.
 *
 * E2B does not run `docker build`: its builder takes a base image plus a
 * list of steps (`RUN`, `COPY`, `ENV`, `WORKDIR`, `USER`) and a start
 * command. This module turns a Dockerfile into that shape and rejects, at
 * plan time, what E2B's builder cannot run, mirroring E2B's own SDK parser
 * (`packages/js-sdk/src/template/dockerfileParser.ts`):
 *
 *   • exactly one `FROM` (no multi-stage builds, no `COPY --from`)
 *   • `ADD` only from the build context (no URLs, no archives auto-extracted)
 *   • `CMD` / `ENTRYPOINT` become the template's start command
 *   • `EXPOSE`, `LABEL`, `VOLUME`, `HEALTHCHECK`, `STOPSIGNAL`, `SHELL`,
 *     `ONBUILD` and `MAINTAINER` are ignored, as E2B ignores them
 *
 * Like E2B's parser, the build starts as `root` in `/` and ends as `user` in
 * `/home/user` unless the Dockerfile sets `USER` / `WORKDIR` itself.
 *
 * Internal: replaced by the shared `@alchemy.run/docker` build plan once it
 * lands.
 */
import * as Effect from "effect/Effect";
import { UnsupportedDockerfileInstruction } from "../Errors.ts";

export type StepType = "RUN" | "COPY" | "ENV" | "WORKDIR" | "USER";

export interface LoweredStep {
  readonly type: StepType;
  readonly args: ReadonlyArray<string>;
}

export interface LoweredDockerfile {
  /** The base image of the single `FROM`. */
  readonly fromImage: string;
  readonly steps: ReadonlyArray<LoweredStep>;
  /** `ENTRYPOINT` + `CMD`, as a shell command. */
  readonly startCmd: string | undefined;
}

const IGNORED = new Set([
  "EXPOSE",
  "LABEL",
  "VOLUME",
  "HEALTHCHECK",
  "STOPSIGNAL",
  "SHELL",
  "ONBUILD",
  "MAINTAINER",
]);

interface Instruction {
  readonly name: string;
  readonly rest: string;
  readonly line: number;
}

/** Joins `\` continuations and drops comments and blank lines. */
const instructionsOf = (text: string): Instruction[] => {
  const lines = text.split(/\r?\n/);
  const out: Instruction[] = [];
  let buffer = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (buffer === "" && (trimmed === "" || trimmed.startsWith("#"))) continue;
    if (buffer !== "" && trimmed.startsWith("#")) continue;
    if (buffer === "") start = i + 1;
    if (trimmed.endsWith("\\")) {
      buffer += trimmed.slice(0, -1) + " ";
      continue;
    }
    buffer += trimmed;
    const match = /^(\S+)\s*([\s\S]*)$/.exec(buffer);
    if (match) out.push({ name: match[1]!.toUpperCase(), rest: match[2]!.trim(), line: start });
    buffer = "";
  }
  return out;
};

/** A JSON-array (exec form) argument list, or undefined for the shell form. */
const execForm = (rest: string): string[] | undefined => {
  if (!rest.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(rest);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Shell-quotes one word for a `/bin/sh -c` command line. */
const shellQuote = (word: string): string =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** Splits on whitespace, honouring single and double quotes. */
const splitWords = (text: string): string[] => {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let inWord = false;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
};

/** `$VAR`, `${VAR}`, `${VAR:-default}` and `${VAR:+alt}` from ARG/ENV values. */
const substitute = (text: string, vars: ReadonlyMap<string, string>): string =>
  text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (
      _,
      braced: string | undefined,
      op: string | undefined,
      word: string | undefined,
      bare: string | undefined,
    ) => {
      const name = braced ?? bare!;
      const value = vars.get(name);
      if (op === "-") return value !== undefined && value !== "" ? value : (word ?? "");
      if (op === "+") return value !== undefined && value !== "" ? (word ?? "") : "";
      return value ?? "";
    },
  );

/** Splits leading `--flag=value` options off an instruction's arguments. */
const flagsOf = (rest: string): { flags: Map<string, string>; body: string } => {
  const flags = new Map<string, string>();
  let body = rest;
  for (;;) {
    const match = /^--([a-zA-Z-]+)(?:=(\S*))?\s+/.exec(body);
    if (!match) break;
    flags.set(match[1]!, match[2] ?? "true");
    body = body.slice(match[0].length);
  }
  return { flags, body };
};

/** `k=v k2="v 2"` or the legacy `k v` form. */
const keyValues = (rest: string): Array<[string, string]> => {
  const words = splitWords(rest);
  if (words.length > 0 && !words[0]!.includes("=")) {
    return [[words[0]!, rest.slice(rest.indexOf(words[0]!) + words[0]!.length).trim()]];
  }
  return words.map((word) => {
    const index = word.indexOf("=");
    return [word.slice(0, index), word.slice(index + 1)] as [string, string];
  });
};

/**
 * Lowers Dockerfile text to E2B build steps. `buildArgs` override `ARG`
 * defaults, like `docker build --build-arg`.
 */
export const lowerDockerfile = (
  text: string,
  buildArgs: Readonly<Record<string, string>> = {},
): Effect.Effect<LoweredDockerfile, UnsupportedDockerfileInstruction> =>
  Effect.suspend(() => {
    const fail = (message: string, line?: number) =>
      Effect.fail(new UnsupportedDockerfileInstruction({ message, line }));
    const instructions = instructionsOf(text);
    const froms = instructions.filter((i) => i.name === "FROM");
    if (froms.length === 0) return fail("a Dockerfile needs a FROM instruction");
    if (froms.length > 1) {
      return fail("E2B templates are single-stage: a Dockerfile has one FROM", froms[1]!.line);
    }
    const from = froms[0]!;

    const vars = new Map<string, string>();
    const argOf = (rest: string) => {
      const [name, value] = rest.includes("=")
        ? [rest.slice(0, rest.indexOf("=")), rest.slice(rest.indexOf("=") + 1)]
        : [rest, undefined];
      const resolved =
        buildArgs[name.trim()] ?? (value !== undefined ? substitute(value, vars) : undefined);
      if (resolved !== undefined) vars.set(name.trim(), resolved.replace(/^["']|["']$/g, ""));
    };

    // ARGs before FROM parameterise the base image.
    for (const instruction of instructions) {
      if (instruction.line >= from.line) break;
      if (instruction.name !== "ARG")
        return fail(`${instruction.name} must follow FROM`, instruction.line);
      argOf(instruction.rest);
    }
    const fromWords = splitWords(flagsOf(from.rest).body);
    const fromImage = substitute(fromWords[0] ?? "", vars);
    if (fromImage === "") return fail("FROM names no image", from.line);

    const steps: LoweredStep[] = [
      { type: "USER", args: ["root"] },
      { type: "WORKDIR", args: ["/"] },
    ];
    let userChanged = false;
    let workdirChanged = false;
    let cmd: string | undefined;
    let entrypoint: string | undefined;

    for (const instruction of instructions) {
      if (instruction.line <= from.line) continue;
      const { name, rest, line } = instruction;
      switch (name) {
        case "ARG":
          argOf(rest);
          break;
        case "RUN": {
          const { body } = flagsOf(rest);
          const exec = execForm(body);
          steps.push({ type: "RUN", args: [exec ? exec.map(shellQuote).join(" ") : body] });
          break;
        }
        case "COPY":
        case "ADD": {
          const { flags, body } = flagsOf(rest);
          if (flags.has("from")) {
            return fail(
              `${name} --from needs a multi-stage build, which E2B does not support`,
              line,
            );
          }
          const words = (execForm(body) ?? splitWords(body)).map((w) => substitute(w, vars));
          if (words.length < 2) return fail(`${name} needs a source and a destination`, line);
          const dest = words.at(-1)!;
          for (const src of words.slice(0, -1)) {
            if (/^[a-z]+:\/\//i.test(src)) {
              return fail(
                `${name} from a URL is not supported by E2B; download it in a RUN step`,
                line,
              );
            }
            if (src.startsWith("/") || src.split("/").includes("..")) {
              return fail(`${name} source ${src} must be inside the build context`, line);
            }
            steps.push({
              type: "COPY",
              args: [src, dest, flags.get("chown") ?? "", flags.get("chmod") ?? ""],
            });
          }
          break;
        }
        case "ENV": {
          const pairs = keyValues(rest).map(([k, v]) => [k, substitute(v, vars)] as const);
          for (const [k, v] of pairs) vars.set(k, v);
          steps.push({ type: "ENV", args: pairs.flatMap(([k, v]) => [k, v]) });
          break;
        }
        case "WORKDIR":
          steps.push({ type: "WORKDIR", args: [substitute(rest, vars)] });
          workdirChanged = true;
          break;
        case "USER":
          steps.push({ type: "USER", args: [substitute(rest, vars)] });
          userChanged = true;
          break;
        case "CMD": {
          const exec = execForm(rest);
          cmd = exec ? exec.map(shellQuote).join(" ") : rest;
          break;
        }
        case "ENTRYPOINT": {
          const exec = execForm(rest);
          entrypoint = exec ? exec.map(shellQuote).join(" ") : rest;
          break;
        }
        default:
          if (!IGNORED.has(name)) return fail(`E2B templates do not support ${name}`, line);
      }
    }

    if (!userChanged) steps.push({ type: "USER", args: ["user"] });
    if (!workdirChanged) steps.push({ type: "WORKDIR", args: ["/home/user"] });

    const startCmd =
      entrypoint !== undefined && cmd !== undefined ? `${entrypoint} ${cmd}` : (entrypoint ?? cmd);
    return Effect.succeed({ fromImage, steps, startCmd });
  });
