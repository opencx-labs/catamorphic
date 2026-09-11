import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  desktopApi,
  type ImportableBrowser,
  type PasswordImportSupport,
} from "../lib/desktop-api.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

export function BrowserImport() {
  const [browsers, setBrowsers] = useState<ImportableBrowser[]>([]);
  const [support, setSupport] = useState<PasswordImportSupport | null>(null);
  const [nativeImport, setNativeImport] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importingPasswords, setImportingPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discover = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detected, capability] = await Promise.all([
        desktopApi.browserImportList(),
        desktopApi.browserImportSupport(),
      ]);
      setBrowsers(detected);
      setSupport(capability);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void discover();
  }, [discover]);

  const run = async (
    browser: ImportableBrowser,
    profile: ImportableBrowser["profiles"][number],
  ) => {
    const key = `${browser.id}:${profile.id}`;
    setImporting(key);
    setMessage(null);
    setError(null);
    try {
      const result = await desktopApi.browserImportRun({
        browserId: browser.id,
        imports: [
          {
            sourceProfileId: profile.id,
            sourceProfileName: profile.name,
            target: "current",
          },
        ],
      });
      setMessage(
        result.bookmarksImported === 1
          ? "Imported 1 bookmark."
          : `Imported ${result.bookmarksImported} bookmarks.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(null);
    }
  };

  const importNative = async (
    browser: ImportableBrowser,
    profileId: string,
  ) => {
    if (!support?.available) return;
    setNativeImport(`${browser.id}:${profileId}`);
    setMessage(null);
    setError(null);
    try {
      const result = await desktopApi.browserImportNativePasswords({
        browserId: browser.id,
        profileId,
      });
      if (result.cancelled) {
        setMessage(
          "Password import cancelled. Your saved passwords are unchanged.",
        );
      } else {
        setMessage(
          [
            `Imported ${result.imported} ${result.imported === 1 ? "password" : "passwords"}.`,
            result.existing
              ? `Kept ${result.existing} existing ${result.existing === 1 ? "account" : "accounts"}.`
              : "",
            result.invalid
              ? `Skipped ${result.invalid} invalid ${result.invalid === 1 ? "entry" : "entries"}.`
              : "",
            result.failed
              ? `Could not decrypt ${result.failed} ${result.failed === 1 ? "entry" : "entries"}. Import a password CSV for these instead.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNativeImport(null);
    }
  };
  const busy =
    importing !== null || importingPasswords || nativeImport !== null;

  const importPasswords = async () => {
    setImportingPasswords(true);
    setMessage(null);
    setError(null);
    try {
      const result = await desktopApi.browserImportPasswords();
      if (!result.cancelled) {
        setMessage(
          result.imported === 1
            ? "Imported 1 password."
            : `Imported ${result.imported} passwords.`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImportingPasswords(false);
    }
  };

  return (
    <section className="mt-4 rounded-lg border border-border bg-bg-raised/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Download className="size-4 text-fg-muted" /> Import browser data
          </h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Bring bookmarks and saved logins into this profile.
          </p>
        </div>
        <ShortcutHint label="Scan again">
          <button
            type="button"
            onClick={() => void discover()}
            aria-label="Scan for browsers again"
            disabled={busy || loading}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            <RefreshCw
              className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
          </button>
        </ShortcutHint>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-fg">
            Passwords from a CSV file
          </p>
          <p className="mt-0.5 text-xs text-fg-muted">
            Choose a password CSV exported by Chrome or Firefox.
          </p>
          <p className="mt-0.5 text-[11px] text-fg-faint">
            The export is not encrypted. Delete it after the import finishes.
          </p>
        </div>
        <PendingButton
          disabled={busy && !importingPasswords}
          pending={importingPasswords}
          pendingLabel="Importing…"
          onClick={() => void importPasswords()}
          className="h-8 shrink-0 rounded-md border border-border px-2.5 text-xs text-fg transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay"
        >
          Import CSV
        </PendingButton>
      </div>

      {support && (
        <p className="mt-3 text-xs leading-5 text-fg-muted">
          {support.available
            ? "Import passwords directly from Chrome, Edge, Opera, Brave, Arc, or Chromium. Confirm with Touch ID or your Mac password, then allow Keychain access if asked. Existing passwords are kept."
            : support.reason}
        </p>
      )}
      {nativeImport && (
        <p className="mt-2 text-xs text-fg-muted" role="status">
          Importing passwords. Complete the macOS authentication and Keychain
          prompts if they appear.
        </p>
      )}

      <div className="mt-3 overflow-hidden rounded-md border border-border">
        {loading ? (
          <p className="px-3 py-4 text-center text-xs text-fg-faint">
            Looking for browser profiles…
          </p>
        ) : browsers.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-fg-faint">
            No supported browser profiles were found.
          </p>
        ) : (
          browsers.flatMap((browser) =>
            browser.profiles.map((profile, index) => {
              const key = `${browser.id}:${profile.id}`;
              return (
                <div
                  key={key}
                  className={`flex items-center gap-3 px-3 py-2.5 ${
                    index || browser !== browsers[0]
                      ? "border-t border-border"
                      : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">
                      {browser.label} · {profile.name}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {profile.bookmarkCount === 1
                        ? "1 bookmark"
                        : `${profile.bookmarkCount} bookmarks`}
                    </p>
                  </div>
                  <PendingButton
                    pending={importing === key}
                    pendingLabel="Importing…"
                    disabled={profile.bookmarkCount === 0 || busy}
                    data-disabled-reason="No bookmarks to import, or another import is in progress"
                    aria-label={`Import bookmarks from ${browser.label}, ${profile.name}`}
                    onClick={() => void run(browser, profile)}
                    className="h-8 rounded-md border border-border px-2.5 text-xs text-fg transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay disabled:opacity-50"
                  >
                    Bookmarks
                  </PendingButton>
                  {support?.available && browser.supportsPasswordImport && (
                    <PendingButton
                      pending={nativeImport === key}
                      pendingLabel="Importing…"
                      disabled={!profile.hasPasswords || busy}
                      aria-label={`Import passwords from ${browser.label}, ${profile.name}`}
                      onClick={() => void importNative(browser, profile.id)}
                      className="h-8 shrink-0 rounded-md border border-border px-2.5 text-xs text-fg transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay disabled:opacity-50"
                    >
                      Passwords
                    </PendingButton>
                  )}
                </div>
              );
            }),
          )
        )}
      </div>
      {message && (
        <p className="mt-2 text-xs text-success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
