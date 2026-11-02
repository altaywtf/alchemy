/**
 * Bundles a template's `main` program and describes how the template runs it.
 *
 * The bundle is copied into the template under {@link APP_DIR} and started
 * with Node as the template's start command, so E2B captures it running in
 * the template's snapshot and every sandbox boots with it already serving on
 * `PORT`. An Effect program (the class form) is wrapped in the generated
 * bootstrap entry; an async program (`main` with no Effect impl) is bundled
 * and run as-is.
 */
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type * as rolldown from "rolldown";

/** Where a template's program lives inside the sandbox. */
export const APP_DIR = "/home/user/alchemy";

/** The port a template's program serves on unless `port` says otherwise. */
export const DEFAULT_PORT = 3000;

/** The image a template with a program is built on unless `image` / `dockerfile` say otherwise. */
export const DEFAULT_PROGRAM_IMAGE = "node:22-bookworm";

export interface ProgramProps {
  /** Module entrypoint, typically `import.meta.url`. */
  readonly main: string;
  /** Named export to load from `main`. @default "default" */
  readonly handler?: string;
  /** Bundler configuration. */
  readonly build?: Bundle.BundleConfig;
  /** Set when the resource was declared without an Effect impl: `main` runs as-is. */
  readonly isExternal?: boolean;
}

export interface BundledProgram {
  /** The bundle's files, relative to {@link APP_DIR}. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>;
  readonly hash: string;
}

/**
 * The generated entry: raises the runtime flag BEFORE the user's module is
 * evaluated (hence the dynamic import), then boots the program. It imports
 * only `@alchemy.run/e2b/Bootstrap` and `main` — see `alchemy/Runtime/Bootstrap`.
 */
const makeBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/e2b/Bootstrap";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

const encoder = new TextEncoder();

export const bundleProgram = Effect.fn(function* (props: ProgramProps) {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* resolveMainPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const plugins: rolldown.RolldownPluginOption = props.isExternal
    ? undefined
    : virtualEntryPlugin(makeBootstrap(props.handler ?? "default"));
  const output = yield* Bundle.build(
    {
      ...props.build?.input,
      input: realMain,
      cwd,
      platform: "node",
      external: [...((props.build?.input?.external as string[] | undefined) ?? [])],
      resolve: {
        conditionNames: [...Bundle.NODE_CONDITION_NAMES],
        ...props.build?.input?.resolve,
      },
      plugins: [props.build?.input?.plugins, plugins],
    },
    {
      ...props.build?.output,
      format: "esm",
      sourcemap: props.build?.output?.sourcemap ?? false,
      minify: props.build?.output?.minify ?? false,
      entryFileNames: "index.mjs",
    },
    props.build,
  );
  return {
    files: output.files.map((file) => ({
      path: file.path,
      contents: typeof file.content === "string" ? encoder.encode(file.content) : file.content,
    })),
    hash: output.hash,
  } satisfies BundledProgram;
});

/**
 * A value as the env var the program reads back through its runtime context:
 * plain strings verbatim, `Redacted` values as the runtime's redacted marker.
 */
const envValue = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : packEnvValue(value);

/** The program's environment: Alchemy's runtime vars, bound env, then the user's `env`. */
export const programEnv = Effect.fn(function* (
  port: number,
  bound: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, unknown>> | undefined,
) {
  const stack = yield* Stack;
  const merged: Record<string, unknown> = {
    ALCHEMY_STACK_NAME: stack.name,
    ALCHEMY_STAGE: stack.stage,
    ALCHEMY_PHASE: "runtime",
    HOST: "0.0.0.0",
    PORT: String(port),
    ...bound,
    ...env,
  };
  return Object.fromEntries(
    Object.entries(merged).flatMap(([key, value]) => {
      const text = envValue(value);
      return text === undefined ? [] : [[key, text]];
    }),
  ) as Record<string, string>;
});

/** Starts the program; the template's snapshot is taken once it answers HTTP. */
export const programCommands = (port: number) => ({
  startCmd: `cd ${APP_DIR} && exec node index.mjs`,
  readyCmd: `node -e "fetch('http://127.0.0.1:${port}/').then(()=>process.exit(0),()=>process.exit(1))"`,
});
