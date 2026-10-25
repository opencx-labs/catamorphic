# Module confinement resource measurements

This compares the same fresh Bun worker with no confinement and with Work's final production launcher. It measures module isolation, not whole-app responsiveness or total Work memory.

Each platform runs 30 paired samples with and without approved network access, after two warmup pairs. Baseline/confined order alternates. A worker computes 200 million integer additions, performs 1,000 cached 4 KiB read/write pairs, makes 100 sequential local HTTP requests when networked, then idles for one second. All data and traffic are synthetic. No external service or project secret is used.

Startup ends at the worker handshake, with the parent already warm. RSS is the larger summed process-tree snapshot at ready or after work. It is not a continuous peak or unique physical memory; shared pages can be counted more than once. Live parent heap is measured after explicit GC and includes the standalone proxy/fixture context.

macOS child CPU uses `/usr/bin/time`. Linux includes live process and reaped-child ticks from `/proc` because Bubblewrap does not propagate descendant usage to GNU time; its sample ends before teardown and is quantized to CLK_TCK. Parent startup CPU and parent workload CPU are listed separately. Accounted CPU adds these to child-tree CPU. Parent workload measurements include the local fixture on both sides, plus the proxy when confined. Measurement commands are excluded from that parent workload interval.

The paired median difference need not equal the difference between the two separate medians. Negative small differences can be noise. Different platforms run on different machines; compare baseline/confined within a platform.

Neither backend imposes CPU or memory quotas. A loaded module is reused until its existing idle retirement; these startup costs are not paid on every row read.


Measured revision: [`35961410632caa9bd87502a4d294ab794b7d8036`](https://github.com/opencx-labs/catamorphic/commit/35961410632caa9bd87502a4d294ab794b7d8036). Both native confinement and benchmark jobs passed in [CI run 40166427215](https://github.com/opencx-labs/catamorphic/actions/runs/40166427215). Raw samples are retained beside this report.

## Observed cost

Paired median startup overhead was 13.3 ms without networking and 10.1 ms with networking on macOS; 3.1 ms and 17.7 ms on Linux. Sampled child-tree RSS was within measurement noise on macOS. Linux added 4.5 MiB without networking and 14.8 MiB with networking. The parent retained about 53 KiB and 62 KiB more live heap for a networked macOS/Linux worker respectively.

For 100 tiny sequential local HTTP requests, the approved-host proxy added 35.0 ms on macOS and 42.5 ms on Linux. Accounted CPU for the full synthetic workload increased by 21.6/57.0 ms on macOS without/with networking, and 0.5/41.6 ms on Linux. The proxy therefore has a real CPU cost when it carries traffic.

Compute paired medians changed by about 6.3 ms on the 104 ms macOS no-network workload, and by under 1 ms in the other three cases. File IO changed by 6.4 ms on the 117 ms macOS no-network workload, and by -2.5 to +0.4 ms in the others. macOS file IO had substantial tail variability; see p95 below. Idle deltas were small (at most +0.3 CPU ms per second); negative differences are noise, not savings. These measurements do not establish whole-app latency or a worst-case resource bound.

## darwin (arm64)

CPU: Apple M1 (Virtual). Kernel: 24.6.0. Bun: 1.4.4. Node: v24.22.1.

### Without network access

30 paired samples.

| Measurement | Baseline median | Confined median | Paired delta median | Paired delta p95 |
| --- | ---: | ---: | ---: | ---: |
| startup ms | 22.91 | 36.45 | +13.26 | +28.51 |
| child-tree RSS MiB | 28.24 | 28.19 | -0.02 | +0.38 |
| compute ms | 103.80 | 105.71 | +6.28 | +16.11 |
| 1000 file pairs ms | 117.49 | 125.29 | +6.39 | +74.67 |
| child-tree CPU ms | 205.00 | 225.00 | +20.00 | +81.00 |
| accounted CPU ms | 211.58 | 230.46 | +21.58 | +85.55 |
| parent startup CPU ms | 3.32 | 4.82 | +1.75 | +5.40 |
| parent workload CPU ms | 0.74 | 0.83 | -0.05 | +3.22 |
| worker idle CPU ms/s | 3.16 | 3.46 | +0.30 | +1.62 |
| live parent heap KiB | 8.35 | 2.84 | -9.76 | +31.27 |

### With approved network access

30 paired samples.

| Measurement | Baseline median | Confined median | Paired delta median | Paired delta p95 |
| --- | ---: | ---: | ---: | ---: |
| startup ms | 24.02 | 34.23 | +10.05 | +22.06 |
| child-tree RSS MiB | 29.08 | 28.86 | -0.17 | +0.23 |
| compute ms | 105.46 | 104.46 | +0.52 | +13.37 |
| 1000 file pairs ms | 118.51 | 117.53 | -2.49 | +66.37 |
| 100 HTTP requests ms | 20.89 | 55.03 | +35.01 | +53.39 |
| child-tree CPU ms | 220.00 | 225.00 | +15.00 | +45.50 |
| accounted CPU ms | 234.98 | 280.23 | +57.03 | +99.94 |
| parent startup CPU ms | 3.35 | 4.95 | +1.51 | +4.15 |
| parent workload CPU ms | 12.11 | 49.98 | +36.98 | +61.96 |
| worker idle CPU ms/s | 3.37 | 3.02 | -0.27 | +0.81 |
| live parent heap KiB | -1.47 | 51.50 | +53.04 | +95.59 |

## linux (x64)

CPU: AMD EPYC. Kernel: 6.6.141. Bun: 1.4.4. Node: v24.22.1.

### Without network access

30 paired samples.

| Measurement | Baseline median | Confined median | Paired delta median | Paired delta p95 |
| --- | ---: | ---: | ---: | ---: |
| startup ms | 10.60 | 14.44 | +3.12 | +7.17 |
| child-tree RSS MiB | 34.15 | 38.63 | +4.49 | +4.60 |
| compute ms | 57.80 | 57.45 | -0.08 | +2.03 |
| 1000 file pairs ms | 9.32 | 9.46 | +0.39 | +1.91 |
| child-tree CPU ms | 90.00 | 90.00 | +0.00 | +10.00 |
| accounted CPU ms | 97.05 | 95.72 | +0.50 | +13.02 |
| parent startup CPU ms | 5.10 | 5.13 | +0.04 | +4.63 |
| parent workload CPU ms | 0.48 | 0.58 | +0.08 | +0.34 |
| worker idle CPU ms/s | 5.70 | 5.94 | +0.11 | +1.90 |
| live parent heap KiB | 3.07 | 8.93 | -1.44 | +31.63 |

### With approved network access

30 paired samples.

| Measurement | Baseline median | Confined median | Paired delta median | Paired delta p95 |
| --- | ---: | ---: | ---: | ---: |
| startup ms | 10.44 | 28.61 | +17.67 | +22.53 |
| child-tree RSS MiB | 35.23 | 50.09 | +14.84 | +14.97 |
| compute ms | 57.13 | 57.23 | -0.09 | +2.41 |
| 1000 file pairs ms | 8.76 | 9.06 | +0.22 | +2.10 |
| 100 HTTP requests ms | 8.11 | 52.04 | +42.48 | +58.94 |
| child-tree CPU ms | 90.00 | 100.00 | +0.00 | +20.00 |
| accounted CPU ms | 105.87 | 151.87 | +41.63 | +67.22 |
| parent startup CPU ms | 5.64 | 6.11 | +0.46 | +6.88 |
| parent workload CPU ms | 9.05 | 49.61 | +39.56 | +52.46 |
| worker idle CPU ms/s | 5.81 | 4.31 | -1.43 | +0.21 |
| live parent heap KiB | 7.43 | 69.24 | +62.23 | +108.05 |

## Platform choice

macOS keeps Seatbelt because Apple provides no supported replacement for these dynamic per-worker profiles. App Sandbox uses signing and entitlements. Linux uses Bubblewrap namespaces, a mandatory seccomp helper, explicit file grants and the same approved-host proxy. Landlock alone names TCP ports rather than destination hosts.

Sources: [Apple App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox), [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing), [Codex Linux launcher](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/src/linux_run_main.rs), [Landlock network access](https://docs.kernel.org/userspace-api/landlock.html).
