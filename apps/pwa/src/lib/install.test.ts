import { describe, expect, it } from "vitest";
import {
  connectedRemoteInstallRoute,
  installPromotionKind,
  prepareRemoteInstall,
} from "./install.js";

const browser = {
  secureContext: true,
  standalone: false,
  dismissed: false,
  hasNativePrompt: false,
  userAgent: "Mozilla/5.0 Chrome/140 Mobile",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};

describe("installPromotionKind", () => {
  it("never promotes again after the user dismisses it", () => {
    expect(
      installPromotionKind({
        ...browser,
        dismissed: true,
        hasNativePrompt: true,
      }),
    ).toBeNull();
  });

  it("does not promise installation on an insecure LAN origin", () => {
    expect(
      installPromotionKind({
        ...browser,
        secureContext: false,
        hasNativePrompt: true,
      }),
    ).toBeNull();
  });

  it("uses the browser prompt when one is available", () => {
    expect(installPromotionKind({ ...browser, hasNativePrompt: true })).toBe(
      "native",
    );
  });

  it("offers manual Safari instructions on iPhone and iPad", () => {
    expect(
      installPromotionKind({
        ...browser,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)",
        platform: "iPhone",
      }),
    ).toBe("ios");
    expect(
      installPromotionKind({
        ...browser,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
  });
});

describe("remote install continuity", () => {
  it("reuses an authenticated connection on later launches", () => {
    expect(
      connectedRemoteInstallRoute(
        {
          serverUrl: "https://catamorphic.example/api",
          remoteProjectId: "project-1",
          sessionId: "session-1",
        },
        [
          {
            id: "connection-1",
            kind: "remote",
            serverUrl: "https://catamorphic.example/api",
            projectId: "project-1",
            credentials: {},
          },
        ],
      ),
    ).toEqual({
      kind: "chat",
      connectionId: "connection-1",
      projectId: "project-1",
      sessionId: "session-1",
    });
  });

  it("puts the project and chat locator in the installed start URL", () => {
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = "/manifest.webmanifest";
    document.head.append(manifest);

    prepareRemoteInstall({
      serverUrl: "https://catamorphic.example/api",
      remoteProjectId: "project-1",
      remoteProjectName: "Support",
      sessionId: "session-1",
    });

    const manifestUrl = new URL(manifest.href);
    const launch = new URL(
      manifestUrl.searchParams.get("launch") ?? "",
      "https://catamorphic.example",
    );
    expect(launch.pathname).toBe("/");
    expect(launch.searchParams.get("server")).toBe(
      "https://catamorphic.example/api",
    );
    expect(launch.searchParams.get("project")).toBe("project-1");
    expect(launch.searchParams.get("session")).toBe("session-1");
    expect(launch.searchParams.get("autoconnect")).toBe("1");

    manifest.remove();
    const callbackManifest = document.createElement("link");
    callbackManifest.rel = "manifest";
    callbackManifest.href = "/manifest.webmanifest";
    document.head.append(callbackManifest);

    prepareRemoteInstall();

    const restoredManifestUrl = new URL(callbackManifest.href);
    const restoredLaunch = new URL(
      restoredManifestUrl.searchParams.get("launch") ?? "",
      "https://catamorphic.example",
    );
    expect(restoredLaunch.searchParams.get("project")).toBe("project-1");
    expect(restoredLaunch.searchParams.get("session")).toBe("session-1");
    expect(restoredLaunch.searchParams.get("autoconnect")).toBe("1");
    localStorage.clear();
    callbackManifest.remove();
  });
});
