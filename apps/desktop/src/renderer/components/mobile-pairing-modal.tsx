import {
  Copy,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { toDataURL } from "qrcode";
import { useCallback, useEffect, useState } from "react";
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
        pwaReady: boolean;
      }
  >({ kind: "loading" });

  const generate = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const info = await desktopApi.mobilePairingStart(context ?? undefined);
      const qr = await toDataURL(info.url, {
        margin: 1,
        width: 240,
        color: { dark: "#000000", light: "#ffffff" },
      });
      setState({
        kind: "ready",
        url: info.url,
        qr,
        expiresAt: info.expiresAt,
        pwaReady: info.pwaReady,
      });
    } catch (error) {
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
    return () => clearInterval(timer);
  }, [open, generate, refreshDevices]);

  if (!open) return null;
  return (
    <Modal open onClose={onClose}>
      <div className="flex w-105 max-w-full flex-col items-center gap-3 p-5 text-center">
        <span className="grid size-10 place-items-center rounded-xl border border-border bg-bg-overlay">
          <Smartphone className="size-5 text-accent" />
        </span>
        <h2 className="text-[15px] font-semibold">Continue on mobile</h2>
        {state.kind === "loading" && (
          <div className="grid h-60 w-60 place-items-center">
            <LoaderCircle className="size-6 animate-spin text-fg-faint" />
          </div>
        )}
        {state.kind === "error" && (
          <p className="text-[13px] text-danger">{state.message}</p>
        )}
        {state.kind === "ready" && (
          <>
            <img
              src={state.qr}
              alt="Pairing QR code"
              className="size-60 rounded-lg bg-white p-2"
              data-testid="mobile-pairing-qr"
            />
            <p className="max-w-xs text-xs leading-5 text-fg-muted">
              Scan with your phone's camera (same Wi-Fi).
              {context?.sessionId
                ? " It opens straight into this chat."
                : " It opens your projects."}{" "}
              The code is single-use and expires in 2 minutes — anyone who scans
              it gets access as you.
            </p>
            {!state.pwaReady && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                The mobile app bundle isn't built yet — run{" "}
                <code>bun run --filter catamorphic-pwa build</code> first.
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(state.url)}
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
          </>
        )}
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
