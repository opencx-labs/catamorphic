#!/usr/bin/env python3
"""Watch a running Work for freezes from outside (macOS).

A packaged Work refuses a debugging port, so this reads what the operating
system already shows about it, and changes nothing:

- each process's main-thread CPU time every 100 ms (libproc). A main thread
  busy for nearly every sample of a stretch could not draw or take input
  for that long: a freeze. It names the process, not the function.
- the delay of an unrouted request to the embedded server, which the main
  process's event loop answers: its stalls freeze every window at once.

    python3 apps/desktop/scripts/live-probe.py [--seconds 300] [--pid <Work pid>]

Prints each stretch as it ends and a summary every 30 seconds. Method and
a reading of the numbers: docs/performance.md, "What is out of sight".
"""

import argparse
import collections
import ctypes
import ctypes.util
import datetime
import subprocess
import threading
import time
import urllib.error
import urllib.request

PROC_PIDLISTTHREADS, PROC_PIDTHREADINFO = 6, 5
MAIN_THREADS = ("CrBrowserMain", "CrRendererMain", "CrGpuMain")
SAMPLE_SECONDS = 0.1
# A thread this busy across consecutive samples is not idling between tasks.
BUSY_FRACTION = 0.85
STRETCH_SECONDS = 0.2
STALL_MS = 40


class ThreadInfo(ctypes.Structure):
    _fields_ = [
        ("user", ctypes.c_uint64),
        ("system", ctypes.c_uint64),
        ("cpu_usage", ctypes.c_int32),
        ("policy", ctypes.c_int32),
        ("run_state", ctypes.c_int32),
        ("flags", ctypes.c_int32),
        ("sleep_time", ctypes.c_int32),
        ("curpri", ctypes.c_int32),
        ("priority", ctypes.c_int32),
        ("maxpriority", ctypes.c_int32),
        ("name", ctypes.c_char * 64),
    ]


libproc = ctypes.CDLL(ctypes.util.find_library("proc"), use_errno=True)
libproc.proc_pidinfo.argtypes = [
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_uint64,
    ctypes.c_void_p,
    ctypes.c_int,
]


def stamp():
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def main_thread_seconds(pid):
    """CPU seconds the process's main thread has used, with its name."""
    handles = (ctypes.c_uint64 * 1024)()
    size = libproc.proc_pidinfo(
        pid, PROC_PIDLISTTHREADS, 0, handles, ctypes.sizeof(handles)
    )
    for index in range(max(size, 0) // 8):
        info = ThreadInfo()
        if (
            libproc.proc_pidinfo(
                pid,
                PROC_PIDTHREADINFO,
                handles[index],
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
            <= 0
        ):
            continue
        name = info.name.decode(errors="replace")
        if name.startswith(MAIN_THREADS):
            return (info.user + info.system) / 1e9, name
    return None


def work_processes(root):
    """The app's own processes: main, GPU and renderers, labelled."""
    table = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,command="], capture_output=True, text=True
    ).stdout
    found = {}
    windows = 0
    for line in table.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, parent, command = int(parts[0]), int(parts[1]), parts[2]
        if pid == root:
            found[pid] = "main"
        elif parent == root and "--type=gpu-process" in command:
            found[pid] = "gpu"
        elif parent == root and "--type=renderer" in command:
            # Pages in tabs carry Blink feature switches; windows do not.
            if "--enable-blink-features" in command:
                found[pid] = f"page:{pid}"
            else:
                windows += 1
                found[pid] = f"window{windows}:{pid}"
    return found


def find_root():
    table = subprocess.run(
        ["ps", "-Ao", "pid=,command="], capture_output=True, text=True
    ).stdout
    for line in table.splitlines():
        pid, _, command = line.strip().partition(" ")
        if command.strip().endswith("/Contents/MacOS/Work"):
            return int(pid)
    raise SystemExit("No running Work found; pass --pid.")


def server_url(root):
    """The embedded server's loopback address, if it answers."""
    listing = subprocess.run(
        ["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-a", "-p", str(root)],
        capture_output=True,
        text=True,
    ).stdout
    for line in listing.splitlines()[1:]:
        address = line.split()[-2]
        url = f"http://{address}"
        try:
            urllib.request.urlopen(f"{url}/api/me", timeout=2).close()
            return url
        except (urllib.error.URLError, OSError):
            continue
    return None


def watch_event_loop(url, until, stalls):
    while time.monotonic() < until:
        started = time.monotonic()
        try:
            urllib.request.urlopen(f"{url}/__probe", timeout=60).close()
        except urllib.error.HTTPError:
            pass  # Unrouted on purpose: the answer's delay is what counts.
        except (urllib.error.URLError, OSError):
            time.sleep(1)
            continue
        delay = (time.monotonic() - started) * 1000
        if delay >= STALL_MS:
            stalls.append(delay)
            print(f"{stamp()} main event loop stalled {delay:.0f} ms", flush=True)
        time.sleep(0.02)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=300)
    parser.add_argument("--pid", type=int, help="Work's main process")
    options = parser.parse_args()
    root = options.pid or find_root()
    processes = work_processes(root)
    until = time.monotonic() + options.seconds
    stalls = []
    url = server_url(root)
    if url:
        threading.Thread(
            target=watch_event_loop, args=(url, until, stalls), daemon=True
        ).start()
    print(
        f"{stamp()} watching {', '.join(processes.values())}"
        + ("" if url else " (no embedded server found: thread times only)"),
        flush=True,
    )

    previous = {pid: main_thread_seconds(pid) for pid in processes}
    previous_at = time.monotonic()
    running = collections.defaultdict(float)
    busy = collections.defaultdict(float)
    stretches = collections.defaultdict(list)
    window_start = previous_at
    while time.monotonic() < until:
        time.sleep(SAMPLE_SECONDS)
        now = time.monotonic()
        elapsed = now - previous_at
        previous_at = now
        for pid, label in processes.items():
            current = main_thread_seconds(pid)
            before = previous.get(pid)
            previous[pid] = current
            if not current or not before:
                continue
            used = current[0] - before[0]
            busy[label] += used
            if used / elapsed >= BUSY_FRACTION:
                running[label] += elapsed
                continue
            if running[label] >= STRETCH_SECONDS:
                stretches[label].append(running[label])
                print(
                    f"{stamp()} {label} main thread busy for {running[label] * 1000:.0f} ms",
                    flush=True,
                )
            running[label] = 0.0
        if now - window_start >= 30:
            span = now - window_start
            parts = []
            for label in sorted(busy):
                share = 100 * busy[label] / span
                if share < 1 and not stretches[label]:
                    continue
                note = (
                    f" ({len(stretches[label])} stretches, longest {max(stretches[label]) * 1000:.0f} ms)"
                    if stretches[label]
                    else ""
                )
                parts.append(f"{label} {share:.0f}%{note}")
            if url:
                parts.append(
                    f"event loop stalls {len(stalls)}"
                    + (f" (longest {max(stalls):.0f} ms)" if stalls else "")
                )
            print(f"{stamp()} 30 s: " + "; ".join(parts), flush=True)
            busy.clear()
            stretches.clear()
            stalls.clear()
            window_start = now


if __name__ == "__main__":
    main()
