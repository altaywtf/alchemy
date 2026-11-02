import * as templates from "@distilled.cloud/e2b/templates";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { e2bName, isGeneratedName } from "./internal/Ownership.ts";
import {
  planTemplateBuild,
  runTemplateBuild,
  type TemplateBuildSpec,
  type TemplateSource,
} from "./internal/TemplateBuild.ts";
import type { Providers } from "./Providers.ts";

export type {
  InlineDockerfile,
  TemplateRegistry,
  TemplateSource,
} from "./internal/TemplateBuild.ts";

export interface TemplateProps extends TemplateSource {
  /**
   * Template name, used to create sandboxes from it. Lowercase letters,
   * digits, `-` and `_`. If omitted, a unique name is generated from the
   * stack, stage and logical ID. Changing it replaces the template.
   */
  name?: string;
  /** Tags assigned to each build, e.g. `["v1"]`. */
  tags?: string[];
  /**
   * vCPUs of every sandbox created from the template.
   * @default 2
   */
  cpuCount?: number;
  /**
   * Memory of every sandbox created from the template, in MiB.
   * @default 512
   */
  memoryMB?: number;
  /** Free disk space every sandbox starts with, in MiB. */
  minFreeDiskMb?: number;
  /**
   * Whether other E2B teams can create sandboxes from the template.
   * @default false
   */
  public?: boolean;
  /** Rebuild every layer on the next deploy, ignoring E2B's cache. */
  force?: boolean;
}

export interface TemplateAttributes {
  /** E2B's template id. Sandboxes are created from it. */
  templateId: string;
  /** The template's name (alias). */
  name: string;
  /** The current build. */
  buildId: string;
  /** Content hash of the build inputs. A deploy rebuilds only when it changes. */
  buildHash: string;
  /** Fully qualified names, e.g. `my-team/my-template:default`. */
  names: string[];
  public: boolean;
  cpuCount: number | undefined;
  memoryMB: number | undefined;
}

export interface Template extends Resource<
  "E2B.Template",
  TemplateProps,
  TemplateAttributes,
  never,
  Providers
> {}

/**
 * An E2B template: the image every sandbox boots from, built by E2B into a
 * Firecracker snapshot.
 *
 * Build from a registry `image`, a `dockerfile` (a path or inline content),
 * or another template (`fromTemplate`). E2B builds remotely, so a deploy
 * needs no Docker daemon: Alchemy lowers the Dockerfile to E2B's build
 * steps and uploads only the `COPY` sources E2B has not seen, by content
 * hash. A deploy starts a new build only when the inputs change.
 *
 * E2B's builder runs one stage. A Dockerfile with several `FROM`s,
 * `COPY --from`, or `ADD <url>` fails at plan time with
 * `UnsupportedDockerfileInstruction`. `EXPOSE`, `LABEL`, `VOLUME` and
 * `HEALTHCHECK` are ignored, as E2B ignores them. `CMD` / `ENTRYPOINT`
 * become the template's start command: it is captured running in the
 * snapshot, so every sandbox starts with it already up.
 *
 * E2B templates carry no labels, so Alchemy recognises its templates by
 * their generated name.
 *
 * ### Building a Template
 * **Example:** From a registry image
 * ```typescript
 * export const Python = E2B.Template("Python", { image: "python:3.12-slim" });
 * ```
 *
 * **Example:** From an inline Dockerfile
 * ```typescript
 * import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
 *
 * export const Agent = E2B.Template("Agent", {
 *   dockerfile: Dockerfile.inline`
 *     FROM node:22-bookworm
 *     RUN apt-get update && apt-get install -y git ripgrep
 *     WORKDIR /work
 *   `,
 *   cpuCount: 2,
 *   memoryMB: 4096,
 * });
 * ```
 *
 * **Example:** From a Dockerfile and its build context
 * ```typescript
 * export const Repo = E2B.Template("Repo", {
 *   context: "./sandbox",
 *   dockerfile: "./sandbox/Dockerfile",
 *   args: { NODE_VERSION: "22" },
 * });
 * ```
 *
 * ### Starting a process in every sandbox
 * **Example:** A dev server that is already running when a sandbox starts
 * ```typescript
 * export const Preview = E2B.Template("Preview", {
 *   image: "node:22-bookworm",
 *   run: ["npm create vite@latest app -- --template react", "cd app && npm install"],
 *   startCmd: "cd /home/user/app && npm run dev -- --host 0.0.0.0 --port 3000",
 *   readyCmd: "curl -sf http://localhost:3000",
 * });
 * ```
 *
 * ### Private base images
 * **Example:** A base image in GHCR
 * ```typescript
 * export const Private = E2B.Template("Private", {
 *   image: "ghcr.io/my-org/base:1",
 *   registry: { username: "my-org", password: Alchemy.Secret("GHCR_TOKEN") },
 * });
 * ```
 *
 * ### Creating sandboxes
 * **Example:** Sandboxes from the template, in a Worker
 * ```typescript
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * const sandbox = yield* sandboxes.create({ timeout: 600 });
 * ```
 *
 * @resource
 * @product Template
 */
export const Template = Resource<Template>("E2B.Template");

/** A template by id, or by name (alias). */
export const observeTemplate = (templateId: string | undefined, name: string) =>
  (templateId !== undefined
    ? templates.getTemplate({ templateID: templateId })
    : templates
        .getTemplateByAlias({ alias: name })
        .pipe(Effect.flatMap((alias) => templates.getTemplate({ templateID: alias.templateID })))
  ).pipe(
    Effect.map((template): templates.GetTemplateResponse | undefined => template),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const specOf = (name: string, news: TemplateProps): TemplateBuildSpec => ({ ...news, name });

export const TemplateProvider = () =>
  Provider.effect(
    Template,
    Effect.gen(function* () {
      return {
        stables: ["templateId", "name"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) return { action: "replace" } as const;
          if (output === undefined) return undefined;
          // The plan hash reads the build context, so a changed file under an
          // unchanged `context` path still rebuilds.
          const plan = yield* planTemplateBuild(specOf(name, news));
          if (plan.hash !== output.buildHash || news.force) return { action: "update" } as const;
          if ((news.public ?? false) !== output.public) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          const template = yield* observeTemplate(output?.templateId, name);
          if (template === undefined) return undefined;
          const attrs: TemplateAttributes = {
            templateId: template.templateID,
            name,
            buildId: template.buildID,
            buildHash: output?.buildHash ?? "",
            names: [...template.names],
            public: template.public,
            cpuCount: template.cpuCount,
            memoryMB: template.memoryMB,
          };
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* e2bName(id, news.name));
          const spec = specOf(name, news);

          // Observe
          const observed = yield* observeTemplate(output?.templateId, name);
          const plan = yield* planTemplateBuild(spec);

          // Ensure — build when there is no ready build of these exact inputs.
          let attrs: TemplateAttributes;
          const upToDate =
            observed !== undefined &&
            observed.buildStatus === "ready" &&
            output?.buildHash === plan.hash &&
            !news.force;
          if (upToDate) {
            attrs = {
              templateId: observed.templateID,
              name,
              buildId: observed.buildID,
              buildHash: plan.hash,
              names: [...observed.names],
              public: observed.public,
              cpuCount: observed.cpuCount,
              memoryMB: observed.memoryMB,
            };
          } else {
            yield* session.note(`Building template ${name}...`);
            const built = yield* runTemplateBuild(spec, plan);
            attrs = {
              templateId: built.templateId,
              name,
              buildId: built.buildId,
              buildHash: plan.hash,
              names: [...built.names],
              public: built.public,
              cpuCount: news.cpuCount,
              memoryMB: news.memoryMB,
            };
          }

          // Sync — visibility.
          const desiredPublic = news.public ?? false;
          if (attrs.public !== desiredPublic) {
            yield* templates.updateTemplate({
              templateID: attrs.templateId,
              public: desiredPublic,
            });
            attrs = { ...attrs, public: desiredPublic };
          }
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* templates
            .deleteTemplate({ templateID: output.templateId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const all = yield* templates.listTemplates({ limit: 100 });
          return all
            .filter((template) => template.aliases.some(isGeneratedName))
            .map((template): TemplateAttributes => ({
              templateId: template.templateID,
              name: template.aliases.find(isGeneratedName) ?? template.templateID,
              buildId: template.buildID,
              buildHash: "",
              names: [...template.names],
              public: template.public,
              cpuCount: template.cpuCount,
              memoryMB: template.memoryMB,
            }));
        }),
      };
    }),
  );
