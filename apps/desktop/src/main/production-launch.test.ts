import { expect, it } from "vitest";
import { assertProductionLaunchArguments } from "./production-launch.js";

it.each([
  ["--remote-debugging-port=9222"],
  ["--remote-debugging-port", "9222"],
  ["--remote-debugging-pipe"],
  ["--remote-debugging-address=0.0.0.0"],
  ["--remote-allow-origins=*"],
  ["--REMOTE-DEBUGGING-PORT=9222"],
  ["-remote-debugging-port=9222"],
  ["-remote-debugging-port", "9222"],
  ["-remote-debugging-pipe"],
])("rejects packaged debugging arguments %j", (...args) => {
  expect(() =>
    assertProductionLaunchArguments({ isPackaged: true, args }),
  ).toThrow("Remove the remote debugging launch flags");
  expect(() =>
    assertProductionLaunchArguments({ isPackaged: false, args }),
  ).not.toThrow();
});

it.each([
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-allow-origins",
])(
  "rejects effective Chromium switch %s even if it is absent from argv",
  (effective) => {
    const hasSwitch = (name: string) => name === effective;
    expect(() =>
      assertProductionLaunchArguments({
        isPackaged: true,
        args: [],
        hasSwitch,
      }),
    ).toThrow("Remove the remote debugging launch flags");
    expect(() =>
      assertProductionLaunchArguments({
        isPackaged: false,
        args: [],
        hasSwitch,
      }),
    ).not.toThrow();
  },
);

it("accepts ordinary packaged launches, including URLs mentioning debugging", () => {
  expect(() =>
    assertProductionLaunchArguments({
      isPackaged: true,
      args: [
        "/Applications/Work.app",
        "work://connect?server=https://remote-debugging.example/api",
      ],
    }),
  ).not.toThrow();
});
