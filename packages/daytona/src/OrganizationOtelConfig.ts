import * as organizations from "@distilled.cloud/daytona/organizations";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { currentOrganizationId } from "./internal/Organization.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationOtelConfigProps {
  /** OTLP/HTTP endpoint sandboxes export telemetry to. */
  endpoint: string;
  /** Headers sent with every export, e.g. an API key. */
  headers?: Record<string, string | Redacted.Redacted<string>>;
}

export interface OrganizationOtelConfigAttributes {
  /** Organization ID. */
  organizationId: string;
  /** OTLP endpoint. */
  endpoint: string;
  /** Header names configured (values are not returned). */
  headerNames: string[];
}

export type OrganizationOtelConfig = Resource<
  "Daytona.OrganizationOtelConfig",
  OrganizationOtelConfigProps,
  OrganizationOtelConfigAttributes,
  never,
  Providers
>;

/**
 * Export the organization's sandbox telemetry (logs, traces, metrics) to
 * your own OpenTelemetry backend. One per organization; destroying it
 * stops the export.
 *
 * ### Exporting Telemetry
 * **Example:** Send sandbox telemetry to Axiom
 * ```typescript
 * export const Telemetry = Daytona.OrganizationOtelConfig("Telemetry", {
 *   endpoint: "https://api.axiom.co",
 *   headers: {
 *     Authorization: Alchemy.Secret("AXIOM_TOKEN"),
 *     "X-Axiom-Dataset": "daytona",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationOtelConfig = Resource<OrganizationOtelConfig>(
  "Daytona.OrganizationOtelConfig",
);

const plainHeaders = (headers: OrganizationOtelConfigProps["headers"]) =>
  headers === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [
          k,
          Redacted.isRedacted(v) ? Redacted.value(v) : v,
        ]),
      );

export const OrganizationOtelConfigProvider = () =>
  Provider.effect(
    OrganizationOtelConfig,
    Effect.succeed({
      stables: ["organizationId"],
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      read: Effect.fn(function* ({ output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const config = yield* organizations.getOrganizationOtelConfig({ organizationId });
        if (!config?.endpoint) return undefined;
        return {
          organizationId,
          endpoint: config.endpoint,
          headerNames: Object.keys(config.headers ?? {}),
        };
      }),
      reconcile: Effect.fn(function* ({ news, olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        // Observe — header values aren't returned, so they are written
        // whenever they changed since the last deploy (or on first deploy).
        const current = yield* organizations.getOrganizationOtelConfig({ organizationId });
        const headers = plainHeaders(news.headers);
        if (
          current?.endpoint !== news.endpoint ||
          olds === undefined ||
          !deepEqual(plainHeaders(olds.headers), headers)
        ) {
          yield* organizations.updateOrganizationOtelConfig({
            organizationId,
            endpoint: news.endpoint,
            headers,
          });
        }
        return { organizationId, endpoint: news.endpoint, headerNames: Object.keys(headers ?? {}) };
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* organizations
          .deleteOrganizationOtelConfig({ organizationId: output.organizationId })
          .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.void));
      }),
    }),
  );
