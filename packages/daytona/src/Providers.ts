import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { DaytonaAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { OrganizationRole, OrganizationRoleProvider } from "./OrganizationRole.ts";
import { Registry, RegistryProvider } from "./Registry.ts";
import { Sandbox, SandboxProvider } from "./Sandbox.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { WarmPool, WarmPoolProvider } from "./WarmPool.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Daytona") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Daytona providers and credentials: every Daytona resource, and the
 * Daytona AuthProvider so `alchemy profile edit` can configure it.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApiKey,
      OrganizationRole,
      Registry,
      Sandbox,
      Secret,
      Snapshot,
      Volume,
      WarmPool,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiKeyProvider(),
        OrganizationRoleProvider(),
        RegistryProvider(),
        SandboxProvider(),
        SecretProvider(),
        SnapshotProvider(),
        VolumeProvider(),
        WarmPoolProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(DaytonaAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
