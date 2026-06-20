import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  AGENT_ADAPTER_TYPES,
  createEnvironmentSchema,
  getEnvironmentCapabilities,
  probeEnvironmentConfigSchema,
  updateEnvironmentSchema,
} from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  issueService,
  instanceSettingsService,
  logActivity,
  projectService,
} from "../services/index.js";
import {
  collectEnvironmentSecretRefs,
  normalizeEnvironmentConfigForPersistence,
  normalizeEnvironmentConfigForProbe,
  readSshEnvironmentPrivateKeySecretId,
  type ParsedEnvironmentConfig,
} from "../services/environment-config.js";
import { probeEnvironment } from "../services/environment-probe.js";
import { secretService } from "../services/secrets.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { getActorInfo } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

export function environmentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = environmentService(db);
  const executionWorkspaces = executionWorkspaceService(db);
  const issues = issueService(db);
  const instanceSettings = instanceSettingsService(db);
  const projects = projectService(db);
  const secrets = secretService(db);

  function parseObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function assertCanAccessInstanceEnvironments(req: Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Instance environment management is restricted to board operators");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }

  async function assertCanReadSecretsForDraftProbe(req: Request, companyId: string) {
    assertCanAccessInstanceEnvironments(req);
    return companyId;
  }

  async function logInstanceEnvironmentActivity(input: {
    actor: ReturnType<typeof getActorInfo>;
    action: string;
    entityId: string;
    details: Record<string, unknown>;
  }) {
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId,
          runId: input.actor.runId,
          action: input.action,
          entityType: "environment",
          entityId: input.entityId,
          details: input.details,
        })
      ),
    );
  }

  async function resolveEnvironmentSecretContextCompanyId(
    req: Request,
    environmentId: string,
    options: { required: boolean },
  ): Promise<string | null> {
    const routeCompanyId =
      typeof req.params.companyId === "string" && req.params.companyId.trim().length > 0
        ? req.params.companyId.trim()
        : typeof req.query.companyId === "string" && req.query.companyId.trim().length > 0
          ? req.query.companyId.trim()
          : null;
    const bindingCompanyIds = await secrets.listBindingCompanyIdsForTarget({
      targetType: "environment",
      targetId: environmentId,
    });
    if (routeCompanyId && bindingCompanyIds.length > 0 && !bindingCompanyIds.includes(routeCompanyId)) {
      throw conflict("Environment secret bindings already use a different company context.");
    }
    if (routeCompanyId) return routeCompanyId;
    if (bindingCompanyIds.length === 1) return bindingCompanyIds[0] ?? null;
    if (bindingCompanyIds.length > 1) {
      throw conflict("Environment secret bindings span multiple companies and require explicit companyId context.");
    }
    if (req.actor.type === "agent" && req.actor.companyId) return req.actor.companyId;
    if (req.actor.type === "board" && Array.isArray(req.actor.companyIds) && req.actor.companyIds.length === 1) {
      return req.actor.companyIds[0] ?? null;
    }
    if (!options.required) return null;
    throw unprocessable(
      "Environment secret management requires a companyId context during the instance-scoped transition.",
    );
  }

  function summarizeEnvironmentUpdate(
    patch: Record<string, unknown>,
    environment: {
      name: string;
      driver: string;
      status: string;
    },
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      changedFields: Object.keys(patch).sort(),
    };

    if (patch.name !== undefined) details.name = environment.name;
    if (patch.driver !== undefined) details.driver = environment.driver;
    if (patch.status !== undefined) details.status = environment.status;
    if (patch.description !== undefined) details.descriptionChanged = true;
    if (patch.config !== undefined) {
      details.configChanged = true;
      details.configTopLevelKeyCount =
        patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)
          ? Object.keys(patch.config as Record<string, unknown>).length
          : 0;
    }
    if (patch.metadata !== undefined) {
      details.metadataChanged = true;
      details.metadataTopLevelKeyCount =
        patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)
          ? Object.keys(patch.metadata as Record<string, unknown>).length
          : 0;
    }

    return details;
  }

  router.get("/companies/:companyId/environments", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const rows = await svc.list({
      status: req.query.status as string | undefined,
      driver: req.query.driver as string | undefined,
    });
    res.json(rows);
  });

  router.get("/companies/:companyId/environments/capabilities", async (req, res) => {
    assertCanAccessInstanceEnvironments(req);
    const pluginDrivers = await listReadyPluginEnvironmentDrivers({
      db,
      workerManager: options.pluginWorkerManager,
    });
    res.json(getEnvironmentCapabilities(
      AGENT_ADAPTER_TYPES,
      {
        sandboxProviders: Object.fromEntries(pluginDrivers.map((driver) => [
          driver.driverKey,
          {
            status: "supported" as const,
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: driver.displayName,
            description: driver.description,
            source: "plugin" as const,
            pluginKey: driver.pluginKey,
            pluginId: driver.pluginId,
            configSchema: driver.configSchema,
          },
        ])),
      },
    ));
  });

  router.post("/companies/:companyId/environments", validate(createEnvironmentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCanAccessInstanceEnvironments(req);
    if (req.body.driver === "local") {
      const existingLocal = await svc.list({ driver: "local" });
      if (existingLocal.length > 0) {
        throw conflict("A local environment already exists for this instance.");
      }
    }
    const actor = getActorInfo(req);
    const input = {
      ...req.body,
      config: await normalizeEnvironmentConfigForPersistence({
        db,
        companyId,
        environmentName: req.body.name,
        driver: req.body.driver,
        secretProvider: getConfiguredSecretProvider(),
        config: req.body.config,
        actor: {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      }),
    };
    const environment = await svc.create(input);
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "environment", targetId: environment.id },
      await collectEnvironmentSecretRefs({ db, environment }),
    );
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.created",
      entityId: environment.id,
      details: {
        name: environment.name,
        driver: environment.driver,
        status: environment.status,
      },
    });
    res.status(201).json(environment);
  });

  router.get("/environments/:id", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCanAccessInstanceEnvironments(req);
    res.json(environment);
  });

  router.get("/environments/:id/leases", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCanAccessInstanceEnvironments(req);
    const leases = await svc.listLeases(environment.id, {
      status: req.query.status as string | undefined,
    });
    res.json(leases);
  });

  router.get("/environment-leases/:leaseId", async (req, res) => {
    const lease = await svc.getLeaseById(req.params.leaseId as string);
    if (!lease) {
      res.status(404).json({ error: "Environment lease not found" });
      return;
    }
    assertCanAccessInstanceEnvironments(req);
    res.json(lease);
  });

  router.patch("/environments/:id", validate(updateEnvironmentSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCanAccessInstanceEnvironments(req);
    const actor = getActorInfo(req);
    const nextDriver = req.body.driver ?? existing.driver;
    const nextName = req.body.name ?? existing.name;
    const companyIdForSecrets =
      req.body.config !== undefined || req.body.driver !== undefined
        ? await resolveEnvironmentSecretContextCompanyId(req, existing.id, { required: true })
        : null;
    const configSource =
      req.body.config !== undefined
        ? req.body.driver !== undefined && req.body.driver !== existing.driver
          ? req.body.config
          : {
              ...parseObject(existing.config),
              ...parseObject(req.body.config),
            }
        : req.body.driver !== undefined && req.body.driver !== existing.driver
          ? {}
          : existing.config;
    const patch = {
      ...req.body,
      ...(req.body.config !== undefined || req.body.driver !== undefined
        ? {
            config: await normalizeEnvironmentConfigForPersistence({
              db,
              companyId: companyIdForSecrets!,
              environmentName: nextName,
              driver: nextDriver,
              secretProvider: getConfiguredSecretProvider(),
              config: configSource,
              actor: {
                agentId: actor.agentId,
                userId: actor.actorType === "user" ? actor.actorId : null,
              },
              pluginWorkerManager: options.pluginWorkerManager,
            }),
          }
        : {}),
    };
    const environment = await svc.update(existing.id, patch);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    if (patch.config !== undefined || patch.driver !== undefined) {
      await secrets.syncSecretRefsForTarget(
        companyIdForSecrets!,
        { targetType: "environment", targetId: environment.id },
        await collectEnvironmentSecretRefs({ db, environment }),
      );
    }
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.updated",
      entityId: environment.id,
      details: summarizeEnvironmentUpdate(patch as Record<string, unknown>, environment),
    });
    res.json(environment);
  });

  router.delete("/environments/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCanAccessInstanceEnvironments(req);
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.flatMap((companyId) => [
        executionWorkspaces.clearEnvironmentSelection(companyId, existing.id),
        issues.clearExecutionWorkspaceEnvironmentSelection(companyId, existing.id),
        projects.clearExecutionWorkspaceEnvironmentSelection(companyId, existing.id),
      ]),
    );
    const removed = await svc.remove(existing.id);
    if (!removed) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    const secretId = readSshEnvironmentPrivateKeySecretId(existing);
    if (secretId) {
      await secrets.remove(secretId);
    }
    const actor = getActorInfo(req);
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.deleted",
      entityId: removed.id,
      details: {
        name: removed.name,
        driver: removed.driver,
        status: removed.status,
      },
    });
    res.json(removed);
  });

  router.post("/environments/:id/probe", async (req, res) => {
    const environment = await svc.getById(req.params.id as string);
    if (!environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    assertCanAccessInstanceEnvironments(req);
    const actor = getActorInfo(req);
    const companyIdForSecrets = await resolveEnvironmentSecretContextCompanyId(req, environment.id, { required: false });
    const probe = await probeEnvironment(db, environment, {
      companyId: companyIdForSecrets,
      pluginWorkerManager: options.pluginWorkerManager,
    });
    await logInstanceEnvironmentActivity({
      actor,
      action: "environment.probed",
      entityId: environment.id,
      details: {
        driver: environment.driver,
        ok: probe.ok,
        summary: probe.summary,
      },
    });
    res.json(probe);
  });

  router.post(
    "/companies/:companyId/environments/probe-config",
    validate(probeEnvironmentConfigSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCanAccessInstanceEnvironments(req);
      if (req.body.driver === "sandbox") {
        // Draft sandbox probes can resolve unbound secret refs, so require
        // the same company-scoped secret-read capability before normalization.
        await assertCanReadSecretsForDraftProbe(req, companyId);
      }
      const actor = getActorInfo(req);
      const normalizedConfig = await normalizeEnvironmentConfigForProbe({
        db,
        companyId,
        driver: req.body.driver,
        config: req.body.config,
        accessContext: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorSource: actor.actorSource,
          heartbeatRunId: actor.runId,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      });
      const environment = {
        id: "unsaved",
        companyId,
        name: req.body.name?.trim() || "Unsaved environment",
        description: req.body.description ?? null,
        driver: req.body.driver,
        status: "active" as const,
        config: normalizedConfig,
        envVars: {},
        metadata: req.body.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const probe = await probeEnvironment(db, environment, {
        companyId,
        pluginWorkerManager: options.pluginWorkerManager,
        resolvedConfig: {
          driver: req.body.driver,
          config: normalizedConfig,
        } as ParsedEnvironmentConfig,
      });
      await logInstanceEnvironmentActivity({
        actor,
        action: "environment.probed_unsaved",
        entityId: "unsaved",
        details: {
          driver: environment.driver,
          ok: probe.ok,
          summary: probe.summary,
          configTopLevelKeyCount: Object.keys(environment.config).length,
        },
      });
      res.json(probe);
    },
  );

  return router;
}
