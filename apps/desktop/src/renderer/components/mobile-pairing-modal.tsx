import {
  CircleAlert,
  Copy,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { toDataURL } from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";

type PairedDevice = Awaited<
  ReturnType<typeof desktopApi.mobilePairingDevices>
>[number];

/**
 * "Continue on mobile": one QR, scanned with the phone camera. The code
 * is single-use and dies in ~2 minutes; scanning hands the phone this
 * desktop's connection (plus the profile's remote-project links) and —
 * when a chat was focused — lands it in that exact conversation.
 */
export function MobilePairingModal({
  open,
  context,
  onClose,
}: {
  open: boolean;
  /** The focused chat when the action ran; the phone opens right into it. */
  context: { projectId?: string; sessionId?: string } | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        url: string;
        qr: string;
        expiresAt: string;
        remote?: { url: string; qr: string; host: string };
      }
  >({ kind: "loading" });
  const generation = useRef(0);
  // Which QR shows: the project's remote server (works anywhere) when it
  // has one, else this desktop over the local Wi-Fi.
  const [target, setTarget] = useState<"remote" | "lan">("lan");

  const generate = useCallback(async () => {
    const request = ++generation.current;
    const startedAt = performance.now();
    setState({ kind: "loading" });
    try {
      const info = await desktopApi.mobilePairingStart(context ?? undefined);
      if (request !== generation.current) return;
      const qrOptions = {
        margin: 1,
        width: 240,
        color: { dark: "#000000", light: "#ffffff" },
      };
      const [qr, remoteQr] = await Promise.all([
        toDataURL(info.url, qrOptions),
        info.remote
          ? toDataURL(info.remote.url, qrOptions)
          : Promise.resolve(undefined),
      ]);
      const remainingEntrance = 180 - (performance.now() - startedAt);
      if (remainingEntrance > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingEntrance));
      }
      if (request !== generation.current) return;
      const remote =
        info.remote && remoteQr
          ? { url: info.remote.url, host: info.remote.host, qr: remoteQr }
          : undefined;
      setTarget(remote ? "remote" : "lan");
      setState({
        kind: "ready",
        url: info.url,
        qr,
        expiresAt: info.expiresAt,
        ...(remote ? { remote } : {}),
      });
    } catch (error) {
      if (request !== generation.current) return;
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Pairing failed to start.",
      });
    }
  }, [context]);

  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const refreshDevices = useCallback(async () => {
    setDevices(await desktopApi.mobilePairingDevices().catch(() => []));
  }, []);

  useEffect(() => {
    if (!open) return;
    void generate();
    void refreshDevices();
    // A scan lands while the modal is open: keep the list live.
    const timer = setInterval(() => void refreshDevices(), 3000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [open, generate, refreshDevices]);

  const isMac = /Mac/i.test(navigator.platform);

  return (
    <Modal open={open} onClose={onClose} labelledBy="mobile-pairing-title">
      <div
        className="flex w-105 max-w-full flex-col items-center gap-3 p-5 text-center"
        data-testid="mobile-pairing-modal"
        data-state={state.kind}
      >
        <span className="grid size-10 place-items-center rounded-xl border border-border bg-bg-overlay">
          <Smartphone className="size-5 text-accent" />
        </span>
        <h2 id="mobile-pairing-title" className="text-[15px] font-semibold">
          Continue on mobile
        </h2>
        <div className="grid h-8 place-items-center">
          {state.kind === "loading" && (
            <span className="text-[11px] font-medium uppercase tracking-wider text-fg-faint">
              Preparing connection
            </span>
          )}
          {state.kind === "error" && (
            <span className="text-[11px] font-medium uppercase tracking-wider text-danger">
              Connection unavailable
            </span>
          )}
          {state.kind === "ready" &&
            (state.remote ? (
              <div className="flex rounded-lg border border-border bg-bg-inset p-0.5 text-[12px]">
                <button
                  type="button"
                  onClick={() => setTarget("remote")}
                  className={`cursor-pointer rounded-md px-3 py-1 transition-colors duration-150 ${target === "remote" ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
                  data-testid="pairing-target-remote"
                >
                  {state.remote.host}
                </button>
                <button
                  type="button"
                  onClick={() => setTarget("lan")}
                  className={`cursor-pointer rounded-md px-3 py-1 transition-colors duration-150 ${target === "lan" ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
                  data-testid="pairing-target-lan"
                >
                  This Wi-Fi
                </button>
              </div>
            ) : (
              <span className="rounded-md border border-border bg-bg-inset px-3 py-1 text-[12px] text-fg-muted">
                This Wi-Fi
              </span>
            ))}
        </div>
        <div
          className={`relative grid size-60 shrink-0 place-items-center overflow-hidden rounded-lg border transition-colors duration-150 ${state.kind === "ready" ? "border-white bg-white" : "border-border bg-bg-inset"}`}
          data-testid="mobile-pairing-qr-stage"
        >
          {state.kind === "loading" && (
            <div className="grid size-16 place-items-center rounded-2xl border border-border bg-bg-overlay">
              <LoaderCircle className="size-6 animate-spin text-fg-faint" />
            </div>
          )}
          {state.kind === "error" && (
            <CircleAlert className="size-8 text-danger" />
          )}
          {state.kind === "ready" && (
            <img
              key={
                target === "remote" && state.remote ? state.remote.qr : state.qr
              }
              src={
                target === "remote" && state.remote ? state.remote.qr : state.qr
              }
              alt="Pairing QR code"
              className="size-60 animate-pairing-qr-in bg-white p-2"
              data-testid="mobile-pairing-qr"
            />
          )}
        </div>
        <div
          className="grid h-20 w-full place-items-center overflow-y-auto"
          aria-live="polite"
        >
          <p
            className={`max-w-xs text-xs leading-5 ${state.kind === "error" ? "text-danger" : "text-fg-muted"}`}
          >
            {state.kind === "loading" &&
              (isMac
                ? "Checking local network access. macOS may ask you to allow Catamorphic."
                : "Checking that this device can accept a mobile connection.")}
            {state.kind === "error" && state.message}
            {state.kind === "ready" && target === "remote" && state.remote
              ? `Scan with your phone. This secure link opens ${state.remote.host} and keeps working when this desktop is off. It includes your server access, so keep it private.`
              : null}
            {state.kind === "ready" && !(target === "remote" && state.remote)
              ? `Scan with your phone on the same Wi-Fi.${
                  context?.sessionId
                    ? " It opens this chat."
                    : " It opens your projects."
                } The code works once, expires in 2 minutes, and grants access as you.`
              : null}
          </p>
        </div>
        <div className="grid h-8 place-items-center">
          {state.kind === "loading" && (
            <span className="text-[11px] text-fg-faint">
              {isMac ? "Waiting for network permission" : "Checking network"}
            </span>
          )}
          {state.kind === "error" && (
            <button
              type="button"
              onClick={() => void generate()}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border-strong px-3 text-[12px] text-fg transition-colors duration-150 hover:bg-bg-overlay"
            >
              <RefreshCw className="size-3.5" />
              Try again
            </button>
          )}
          {state.kind === "ready" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    target === "remote" && state.remote
                      ? state.remote.url
                      : state.url,
                  )
                }
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border-strong px-3 text-[12px] text-fg transition-colors duration-150 hover:bg-bg-overlay"
              >
                <Copy className="size-3.5" />
                Copy link
              </button>
              <button
                type="button"
                onClick={() => void generate()}
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[12px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              >
                <RefreshCw className="size-3.5" />
                New code
              </button>
            </div>
          )}
        </div>
        {devices.length > 0 && (
          <div className="w-full border-t border-border pt-3 text-left">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Paired devices
            </h3>
            <ul className="flex flex-col">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center gap-2 py-1.5"
                  data-testid="paired-device"
                >
                  <Smartphone className="size-3.5 shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {device.label}
                    </span>
                    <span className="block truncate text-[11px] text-fg-faint">
                      {device.lastSeenAt
                        ? `last seen ${relativeTime(device.lastSeenAt)}`
                        : `paired ${relativeTime(device.createdAt)}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void desktopApi
                        .mobilePairingRevoke(device.id)
                        .then(refreshDevices)
                    }
                    className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-danger"
                    aria-label={`Revoke ${device.label}`}
                    data-testid="revoke-device"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
