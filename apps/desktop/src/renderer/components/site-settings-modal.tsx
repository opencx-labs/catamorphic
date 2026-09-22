import {
  ChevronRight,
  Cookie,
  Lock,
  RotateCcw,
  ShieldQuestion,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  customizedKinds,
  describeRequest,
  effectivePermission,
  SITE_PERMISSION_KINDS,
  SITE_PERMISSION_STATES,
  SITE_PERMISSIONS,
  type SiteDetails,
  type SitePermissionKind,
  type SitePermissionRequest,
  type SitePermissionState,
  siteHost,
} from "../../shared/site-settings.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  SITE_PERMISSION_ICONS,
  STATE_LABELS,
  useSiteDetails,
} from "../lib/site-settings.js";
import { Modal } from "./modal.js";
import { AnimatedHeight } from "./modal-tabs.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";

/**
 * One modal for everything about a site (ADR 0150): what it may use, what
 * it stored, and the prompt when a page asks for something new. Opened by
 * the toolbar gear, the palette, a Sites row, or a page's request. With a
 * request pending the question leads and the rest folds away; opened by
 * hand, the permissions and data are laid out in full.
 */
export function SiteSettingsHost({
  origin,
  onClose,
}: {
  /** The site opened by hand; null when only a request can show it. */
  origin: string | null;
  onClose: () => void;
}) {
  const [requests, setRequests] = useState<SitePermissionRequest[]>([]);
  useEffect(() => {
    const stopRequests = desktopApi.onSitePermissionRequest((request) =>
      setRequests((queue) => [...queue, request]),
    );
    const stopWithdrawn = desktopApi.onSitePermissionWithdrawn(({ ids }) =>
      setRequests((queue) =>
        queue.filter((request) => !ids.includes(request.id)),
      ),
    );
    return () => {
      stopRequests();
      stopWithdrawn();
    };
  }, []);
  const request = requests[0] ?? null;
  const shown = request?.origin ?? origin;
  const answer = (decision: "allow" | "block", remember: boolean) => {
    if (!request) return;
    setRequests((queue) => queue.filter((entry) => entry.id !== request.id));
    void desktopApi
      .sitePermissionAnswer({ id: request.id, decision, remember })
      .catch(() => {});
  };
  const close = () => {
    // Dismissing a prompt refuses it once, like closing Chrome's bubble;
    // nothing is remembered.
    if (request) answer("block", false);
    else onClose();
  };
  return (
    <Modal
      open={shown !== null}
      onClose={close}
      width={440}
      labelledBy="site-settings-title"
    >
      {shown && (
        <SiteSettingsCard
          key={shown}
          origin={shown}
          request={request}
          queued={Math.max(0, requests.length - 1)}
          onAnswer={answer}
          onClose={close}
        />
      )}
    </Modal>
  );
}

function SiteSettingsCard({
  origin,
  request,
  queued,
  onAnswer,
  onClose,
}: {
  origin: string;
  request: SitePermissionRequest | null;
  queued: number;
  onAnswer: (decision: "allow" | "block", remember: boolean) => void;
  onClose: () => void;
}) {
  const { details, error } = useSiteDetails(origin);
  const host = siteHost(origin);
  const secure = origin.startsWith("https:");
  // With a question on the table everything else starts folded.
  const [permissionsOpen, setPermissionsOpen] = useState(request === null);
  const [dataOpen, setDataOpen] = useState(request === null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const permissions = details?.permissions ?? {};
  const customized = customizedKinds(permissions);

  const setState = async (
    kind: SitePermissionKind,
    state: SitePermissionState,
  ) => {
    setBusy(kind);
    setActionError(null);
    try {
      await desktopApi.siteSettingsSet({ origin, kind, state });
    } catch {
      setActionError("Could not save that choice. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setActionError(null);
    try {
      await desktopApi.siteSettingsReset({ origin });
    } catch {
      setActionError("Could not reset permissions. Try again.");
    }
  };
  const deleteData = async () => {
    if (deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      await desktopApi.siteSettingsClearData({ origin });
      setConfirmDelete(false);
    } catch {
      setActionError("Could not delete this site's data. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-5" data-testid="site-settings-modal">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg-overlay">
          <SiteFavicon
            url={origin}
            faviconUrl={details?.faviconUrl}
            className="size-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="site-settings-title"
            className="truncate text-sm font-semibold text-fg"
          >
            {host}
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-muted">
            {secure ? (
              <>
                <Lock className="size-3 shrink-0" />
                Secure connection
              </>
            ) : (
              "Not secure"
            )}
          </p>
        </div>
        <ShortcutHint label="Close" shortcut="Esc">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close site settings"
            className="-mr-1 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </ShortcutHint>
      </div>

      {request && (
        <PermissionPrompt
          key={request.id}
          host={host}
          request={request}
          queued={queued}
          details={details}
          onAnswer={onAnswer}
        />
      )}

      <Section
        icon={<ShieldQuestion className="size-3.5" />}
        heading="Permissions"
        summary={
          customized.length === 0
            ? "Defaults"
            : `${customized.length} customized`
        }
        open={permissionsOpen}
        onToggle={() => setPermissionsOpen((value) => !value)}
        action={
          customized.length > 0 && (
            <ShortcutHint label="Back to the defaults">
              <button
                type="button"
                onClick={() => void reset()}
                className="button-ghost button-sm"
                data-testid="site-settings-reset"
              >
                <RotateCcw className="size-3" />
                Reset
              </button>
            </ShortcutHint>
          )
        }
        testId="site-settings-permissions"
      >
        <ul className="flex flex-col">
          {SITE_PERMISSION_KINDS.map((kind) => {
            const Icon = SITE_PERMISSION_ICONS[kind];
            const definition = SITE_PERMISSIONS[kind];
            const state = effectivePermission(permissions, kind);
            const denied =
              (kind === "camera" || kind === "microphone") &&
              details?.system[kind] === "denied";
            const requested = request?.kinds.includes(kind);
            return (
              <li
                key={kind}
                className={`flex flex-col rounded-md transition-colors duration-150 ${
                  requested ? "bg-accent/10" : ""
                }`}
                data-testid={`site-permission-${kind}`}
              >
                <div className="flex h-9 items-center gap-3 px-2">
                  <Icon className="size-4 shrink-0 text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-fg">
                      {definition.label}
                    </p>
                  </div>
                  <select
                    aria-label={`${definition.label} permission`}
                    value={state}
                    disabled={busy === kind || !details}
                    onChange={(event) =>
                      void setState(
                        kind,
                        event.target.value as SitePermissionState,
                      )
                    }
                    className={`field h-7 w-[132px] shrink-0 rounded-md px-2 text-xs ${
                      permissions[kind] === undefined
                        ? "text-fg-muted"
                        : "text-fg"
                    }`}
                  >
                    {SITE_PERMISSION_STATES.filter(
                      (option) => option !== "ask" || definition.prompts,
                    ).map((option) => (
                      <option key={option} value={option}>
                        {STATE_LABELS[option]}
                        {option === definition.default ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                {(definition.description || denied) && (
                  <p className="-mt-1 px-2 pb-2 pl-9 text-[11px] leading-4 text-fg-faint">
                    {denied ? (
                      <>
                        <span className="text-warning">
                          Work has no {definition.label.toLowerCase()} access on
                          this Mac.
                        </span>{" "}
                        <button
                          type="button"
                          onClick={() =>
                            void desktopApi.siteSettingsOpenSystemPrivacy({
                              kind,
                            })
                          }
                          className="cursor-pointer text-fg-muted underline decoration-fg-faint underline-offset-2 transition-colors duration-150 hover:text-fg"
                        >
                          Open System Settings
                        </button>
                      </>
                    ) : (
                      definition.description
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        icon={<Cookie className="size-3.5" />}
        heading="Site data"
        summary={
          details
            ? details.cookies === 0
              ? "No cookies"
              : `${details.cookies} ${details.cookies === 1 ? "cookie" : "cookies"}`
            : "…"
        }
        open={dataOpen}
        onToggle={() => setDataOpen((value) => !value)}
        testId="site-settings-data"
      >
        <div className="flex items-center gap-3 px-2 py-1">
          <p className="min-w-0 flex-1 text-[12px] leading-4 text-fg-muted">
            Cookies, local storage, caches and service workers this site keeps
            in this profile. Deleting them signs you out of it.
          </p>
          <button
            type="button"
            disabled={!details}
            data-disabled-reason="Still reading this site's data"
            onClick={() => setConfirmDelete(true)}
            className="button-secondary button-sm"
            data-testid="site-settings-delete-data"
          >
            Delete data
          </button>
        </div>
      </Section>

      {(error || actionError) && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {actionError ?? error}
        </p>
      )}

      <Modal
        open={confirmDelete}
        onClose={() => {
          if (!deleting) setConfirmDelete(false);
        }}
        labelledBy="site-delete-data-title"
        width={360}
      >
        <div className="p-5" data-testid="site-settings-delete-confirm">
          <h2
            id="site-delete-data-title"
            className="text-sm font-semibold text-fg"
          >
            Delete data for {host}?
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-fg-muted">
            {details?.cookies
              ? `${details.cookies} ${details.cookies === 1 ? "cookie" : "cookies"} and everything the site stored go away. `
              : "Everything the site stored goes away. "}
            You may need to sign in to it again. Its permissions stay.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              data-disabled-reason="Wait for the data to finish deleting"
              onClick={() => setConfirmDelete(false)}
              className="button-ghost"
            >
              Cancel
            </button>
            <PendingButton
              pending={deleting}
              onClick={() => void deleteData()}
              className="button-danger"
              data-testid="site-settings-delete-confirm-button"
            >
              Delete data
            </PendingButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PermissionPrompt({
  host,
  request,
  queued,
  details,
  onAnswer,
}: {
  host: string;
  request: SitePermissionRequest;
  queued: number;
  details: SiteDetails | null;
  onAnswer: (decision: "allow" | "block", remember: boolean) => void;
}) {
  const kinds = request.kinds;
  const systemDenied = kinds.filter(
    (kind) =>
      (kind === "camera" || kind === "microphone") &&
      details?.system[kind] === "denied",
  );
  return (
    <div
      className="mt-4 rounded-lg border border-accent/30 bg-accent/8 p-4 animate-fade-in"
      data-testid="site-permission-prompt"
    >
      <div className="flex items-start gap-3">
        <span className="flex shrink-0 -space-x-1">
          {kinds.map((kind) => {
            const Icon = SITE_PERMISSION_ICONS[kind];
            return (
              <span
                key={kind}
                className="grid size-8 place-items-center rounded-full border border-border bg-bg-raised"
              >
                <Icon className="size-4 text-accent" />
              </span>
            );
          })}
        </span>
        <p className="min-w-0 flex-1 pt-1 text-[13px] leading-5 text-fg">
          <span className="font-medium">{host}</span> wants to{" "}
          {describeRequest(kinds)}
        </p>
      </div>
      {systemDenied.length > 0 && (
        <p className="mt-3 text-[11px] leading-4 text-warning">
          Work has no {systemDenied.map((kind) => kind).join(" or ")} access on
          this Mac, so the site cannot use it until you turn that on in System
          Settings.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onAnswer("allow", true)}
          className="button-primary"
          data-testid="site-permission-allow"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => onAnswer("allow", false)}
          className="button-secondary"
          data-testid="site-permission-allow-once"
        >
          Allow this time
        </button>
        <button
          type="button"
          onClick={() => onAnswer("block", true)}
          className="button-ghost ml-auto"
          data-testid="site-permission-block"
        >
          Block
        </button>
      </div>
      <p className="mt-3 text-[11px] leading-4 text-fg-faint">
        Allow and Block are remembered for {host}; change them below or on the
        Sites page anytime.
        {queued > 0 &&
          ` ${queued} more ${queued === 1 ? "request is" : "requests are"} waiting.`}
      </p>
    </div>
  );
}

function Section({
  icon,
  heading,
  summary,
  open,
  onToggle,
  action,
  children,
  testId,
}: {
  icon: React.ReactNode;
  heading: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  const id = useId();
  return (
    <section className="mt-4" data-testid={testId} data-open={open}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={id}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 hover:bg-bg-overlay"
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-fg-faint transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
            <span className="text-fg-muted">{icon}</span>
            {heading}
          </span>
          <span className="ml-auto truncate text-[11px] text-fg-faint">
            {summary}
          </span>
        </button>
        {action}
      </div>
      <AnimatedHeight>
        {open && (
          <div id={id} className="animate-fade-in pt-1">
            {children}
          </div>
        )}
      </AnimatedHeight>
    </section>
  );
}
