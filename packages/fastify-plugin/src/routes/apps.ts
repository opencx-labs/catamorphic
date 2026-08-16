import {
  type AppHostTheme,
  appGuestCsp,
  buildAppGuestDocument,
} from "@catamorphic/app";
import {
  AppBuildFailedError,
  AppBundleTooLargeError,
  AppNotFoundError,
  AppPublishStateError,
  AppStorageSnapshotTooLargeError,
  AppVersionNotFoundError,
  type Identity,
  narrowIdentity,
  RunNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  AppSummarySchema,
  AppVersionSchema,
  AppViewStateSchema,
  BuildAppSchema,
  CallRunSchema,
  ErrorSchema,
  ProjectAppParamsSchema,
  ProjectAppVersionParamsSchema,
  ProjectIdParamsSchema,
  RunCallOutcomeSchema,
  RunDetailSchema,
  RunSchema,
  TriggerRunSchema,
} from "../schemas.js";
import { replyForTriggerError } from "./run-errors.js";

const AppChannelSchema = z.enum(["published", "dev"]);

/**
 * Every viewer-facing app route narrows whoever arrives to this one app
 * (ADR 0053): a builder's full identity is confined to the app while inside
 * it — the untrusted bundle never inherits project access — and a viewer's
 * scoped identity must cover the app or ends up with an empty scope. The
 * narrowing is structural (it is the route, not a header the client sends),
 * so there is no claim to validate and nothing to forge.
 */
function appIdentity(
  request: FastifyRequest,
  params: { projectId: string; appName: string },
  channel?: "published" | "dev",
): Identity {
  return narrowIdentity(resolveIdentity(request), {
    kind: "app",
    projectId: params.projectId,
    name: params.appName,
    ...(channel ? { channel } : {}),
  });
}

export function registerAppRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: z.array(AppSummarySchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const list = await ctx.core.apps.list({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
      });
      return reply.send(list);
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps/:appName/versions",
    schema: {
      params: ProjectAppParamsSchema,
      response: { 200: z.array(AppVersionSchema), 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const versions = await ctx.core.apps.listVersions({
        identity: resolveIdentity(request),
        projectId: request.params.projectId,
        appName: request.params.appName,
      });
      return reply.send(versions);
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/apps/:appName/builds",
    schema: {
      params: ProjectAppParamsSchema,
      body: BuildAppSchema,
      response: {
        201: AppVersionSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const version = await ctx.core.apps.build({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          appName: request.params.appName,
          kind: request.body.kind,
          commitSha: request.body.commitSha,
        });
        return reply.status(201).send(version);
      } catch (err) {
        if (err instanceof AppNotFoundError)
          return reply.status(404).send({ error: err.message });
        if (
          err instanceof AppPublishStateError ||
          err instanceof AppBuildFailedError ||
          err instanceof AppBundleTooLargeError
        )
          return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/app-versions/:versionId/publish",
    schema: {
      params: ProjectAppVersionParamsSchema,
      response: {
        200: AppVersionSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const version = await ctx.core.apps.publish({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          versionId: request.params.versionId,
        });
        return reply.send(version);
      } catch (err) {
        if (err instanceof AppVersionNotFoundError)
          return reply.status(404).send({ error: err.message });
        if (err instanceof AppPublishStateError)
          return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps/:appName/view-state",
    schema: {
      params: ProjectAppParamsSchema,
      querystring: z.object({
        channel: AppChannelSchema.optional(),
      }),
      response: { 200: AppViewStateSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const state = await ctx.core.apps.viewState({
        identity: appIdentity(request, request.params, request.query.channel),
        projectId: request.params.projectId,
        appName: request.params.appName,
        channel: request.query.channel,
      });
      if (state.state !== "ready") return reply.send(state);
      // The guest URL is origin-absolute (derived from this request) because
      // the mount's iframe navigates to it directly — a relative path would
      // resolve against the host shell's origin, not the API's.
      const guestUrl = new URL(
        (request.url.split("?")[0] ?? request.url).replace(
          /\/view-state$/,
          "/guest",
        ),
        `${request.protocol}://${request.host}`,
      );
      if (request.query.channel) {
        guestUrl.searchParams.set("channel", request.query.channel);
      }
      return reply.send({
        state: "ready",
        appId: state.appId,
        versionId: state.versionId,
        guestUrl: guestUrl.toString(),
      });
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/apps/:appName/storage",
    schema: {
      params: ProjectAppParamsSchema,
      body: z.object({
        /** Full localStorage snapshot from the guest's persistent shim. */
        data: z.record(z.string().max(4096), z.string()),
      }),
      response: {
        204: z.null(),
        404: ErrorSchema,
        413: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        await ctx.core.appStorage.put(
          appIdentity(request, request.params),
          request.params.projectId,
          request.params.appName,
          request.body.data,
        );
      } catch (err) {
        if (err instanceof AppNotFoundError)
          return reply.status(404).send({ error: err.message });
        if (err instanceof AppStorageSnapshotTooLargeError)
          return reply.status(413).send({ error: err.message });
        throw err;
      }
      return reply.status(204).send(null);
    },
  });

  // --- App-originated execution (ADR 0053) ---
  // The mount forwards a guest's workflow calls here rather than to the
  // project's run routes. The URL names the app, so the identity is narrowed
  // structurally and the server re-authorizes every call against the app's
  // active version's frozen workflow set.

  typed.route({
    method: "POST",
    url: "/projects/:projectId/apps/:appName/calls/:workflowName",
    schema: {
      params: ProjectAppParamsSchema.extend({ workflowName: z.string() }),
      querystring: z.object({ channel: AppChannelSchema.optional() }),
      body: CallRunSchema,
      response: {
        200: RunCallOutcomeSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        429: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const outcome = await ctx.core.runs.call({
          identity: appIdentity(request, request.params, request.query.channel),
          projectId: request.params.projectId,
          workflowName: request.params.workflowName,
          input: request.body.input,
          ...(request.body.correlationKey === undefined
            ? {}
            : { correlationKey: request.body.correlationKey }),
          ...(request.body.onConflict === undefined
            ? {}
            : { onConflict: request.body.onConflict }),
          ...(request.body.budgetMs === undefined
            ? {}
            : { budgetMs: request.body.budgetMs }),
        });
        return reply.send(outcome);
      } catch (err) {
        return replyForTriggerError(err, reply) ?? Promise.reject(err);
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/apps/:appName/runs/:workflowName",
    schema: {
      params: ProjectAppParamsSchema.extend({ workflowName: z.string() }),
      querystring: z.object({ channel: AppChannelSchema.optional() }),
      body: TriggerRunSchema,
      response: {
        201: RunSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema,
        429: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const run = await ctx.core.runs.triggerProduction({
          identity: appIdentity(request, request.params, request.query.channel),
          projectId: request.params.projectId,
          workflowName: request.params.workflowName,
          input: request.body.input,
          ...(request.body.correlationKey === undefined
            ? {}
            : { correlationKey: request.body.correlationKey }),
          ...(request.body.onConflict === undefined
            ? {}
            : { onConflict: request.body.onConflict }),
        });
        return reply.status(201).send(run);
      } catch (err) {
        return replyForTriggerError(err, reply) ?? Promise.reject(err);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps/:appName/runs/:runId",
    schema: {
      params: ProjectAppParamsSchema.extend({ runId: z.string().uuid() }),
      querystring: z.object({ channel: AppChannelSchema.optional() }),
      response: {
        200: RunDetailSchema,
        403: ErrorSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        return reply.send(
          await ctx.core.runs.get({
            identity: appIdentity(
              request,
              request.params,
              request.query.channel,
            ),
            runId: request.params.runId,
          }),
        );
      } catch (err) {
        if (err instanceof RunNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/apps/:appName/guest",
    schema: {
      params: ProjectAppParamsSchema,
      querystring: z.object({
        channel: AppChannelSchema.optional(),
        // JSON-encoded AppHostTheme; validated by parseGuestTheme (a zod
        // transform here would not survive OpenAPI spec generation).
        theme: z.string().max(8192).optional(),
      }),
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      const identity = appIdentity(
        request,
        request.params,
        request.query.channel,
      );
      const state = await ctx.core.apps.viewState({
        identity,
        projectId: request.params.projectId,
        appName: request.params.appName,
        channel: request.query.channel,
      });
      if (state.state !== "ready") {
        return reply.status(404).send({ error: `App is ${state.state}` });
      }
      // The caller's persisted app-local storage is baked into the shim so
      // the app's synchronous reads work from its first line.
      const storage = await ctx.core.appStorage.get(
        identity,
        request.params.projectId,
        request.params.appName,
      );
      // The document embeds the (channel-resolved) version's bundle AND the
      // storage seed, so the validator carries both: a republish, a newer
      // dev build, or a storage write changes it and the revalidation
      // misses; otherwise the browser's copy is good.
      const etag = `"${state.versionId}-${request.query.theme ? "t" : "n"}-${storage.revision}"`;
      if (request.headers["if-none-match"] === etag) {
        return reply
          .status(304)
          .header("etag", etag)
          .header("cache-control", "private, no-cache")
          .send();
      }
      // The CSP travels as a response header (authoritative before any
      // parsing) and again as the document's own meta tag via the builder.
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header(
          "content-security-policy",
          appGuestCsp(state.allowedNetworkOrigins),
        )
        .header("etag", etag)
        .header("cache-control", "private, no-cache")
        .send(
          buildAppGuestDocument({
            code: state.code,
            css: state.css,
            theme: parseGuestTheme(request.query.theme),
            allowedNetworkOrigins: state.allowedNetworkOrigins,
            storageSeed: storage.data,
          }),
        );
    },
  });

  // Broad enough for any CSS value syntax (color functions, font stacks,
  // cubic-bezier curves); excludes the characters that could close the style
  // rule or the style element the theme lands in. Fonts get stack-length
  // headroom; single values (radii, sizes, durations, easing) stay short.
  const safeCssValue = (max: number) =>
    z
      .string()
      .max(max)
      .regex(/^[^<>{};]*$/);
  // `.catch(undefined)` drops an invalid leaf while keeping its siblings.
  const cssLeaf = (max: number) =>
    safeCssValue(max).optional().catch(undefined);
  const ColorTokenShape = z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/i)
    .max(40);
  const ColorValueShape = safeCssValue(200);

  const GuestFeelShapes = {
    fonts: z.object({ sans: cssLeaf(200), mono: cssLeaf(200) }),
    radii: z.object({ sm: cssLeaf(64), md: cssLeaf(64), lg: cssLeaf(64) }),
    easing: safeCssValue(64),
    baseFontSize: safeCssValue(64),
    rowHeight: safeCssValue(64),
    motion: z.object({
      fast: cssLeaf(64),
      base: cssLeaf(64),
      slow: cssLeaf(64),
    }),
  } as const;

  /**
   * The theme rides the guest URL as JSON so the document paints in the
   * host's look on first render (no flash, and the browser cache key
   * naturally varies with it). The URL is caller-controlled, so the shape
   * and character set are validated here — per field: an unknown or invalid
   * field (or color entry) is dropped, never the whole theme. Only a theme
   * without a valid appearance is unusable and yields an unthemed document.
   */
  function parseGuestTheme(raw: string | undefined): AppHostTheme | undefined {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object") return undefined;
    const candidate = parsed as Record<string, unknown>;
    const appearance = z
      .enum(["dark", "light"])
      .safeParse(candidate.appearance);
    if (!appearance.success) return undefined;
    const theme: AppHostTheme = { appearance: appearance.data, colors: {} };
    // Colors survive entry-by-entry: one hostile value drops that entry.
    if (candidate.colors !== null && typeof candidate.colors === "object") {
      for (const [token, value] of Object.entries(
        candidate.colors as Record<string, unknown>,
      )) {
        if (
          ColorTokenShape.safeParse(token).success &&
          ColorValueShape.safeParse(value).success
        ) {
          (theme.colors as Record<string, string>)[token] = value as string;
        }
      }
    }
    for (const key of [
      "fonts",
      "radii",
      "easing",
      "baseFontSize",
      "rowHeight",
      "motion",
    ] as const) {
      if (candidate[key] === undefined) continue;
      const field = GuestFeelShapes[key].safeParse(candidate[key]);
      if (field.success) theme[key] = field.data as never;
    }
    return theme;
  }

  typed.route({
    method: "GET",
    url: "/projects/:projectId/app-versions/:versionId/bundle",
    schema: {
      params: ProjectAppVersionParamsSchema,
      response: {
        200: z.object({
          code: z.string(),
          css: z.string(),
          etag: z.string(),
        }),
        304: z.null(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.apps)
        return reply.status(503).send({ error: "Apps not configured" });
      try {
        const identity = resolveIdentity(request);
        // Version-addressed and append-only: the same versionId always names
        // the same bytes, so a revalidation can skip loading the bundle and a
        // fresh response can be cached indefinitely. Authorization happens
        // first either way — the validator comes from the caller's own URL,
        // so a 304 answered before the access check would be an existence
        // oracle for arbitrary version ids.
        const etag = `"${request.params.versionId}"`;
        if (request.headers["if-none-match"] === etag) {
          await ctx.core.apps.assertBundleReadable({
            identity,
            projectId: request.params.projectId,
            versionId: request.params.versionId,
          });
          return reply
            .status(304)
            .header("etag", etag)
            .header("cache-control", "private, max-age=31536000, immutable")
            .send(null);
        }
        const bundle = await ctx.core.apps.getBundle({
          identity,
          projectId: request.params.projectId,
          versionId: request.params.versionId,
        });
        return reply
          .header("etag", bundle.etag)
          .header("cache-control", "private, max-age=31536000, immutable")
          .send(bundle);
      } catch (err) {
        if (err instanceof AppVersionNotFoundError)
          return reply.status(404).send({ error: err.message });
        throw err;
      }
    },
  });
}
