import { type ChildProcess, spawn } from "node:child_process";
import type { VoicePhase } from "../../shared/voice.js";

/**
 * What voice is doing while other apps' audio stays lowered: listening for
 * the person, hearing them, and waiting on the agent. The agent speaking is
 * not among them: macOS lowers Work's own sound with everyone else's.
 */
export const QUIET_PHASES: ReadonlySet<VoicePhase> = new Set([
  "listening",
  "hearing",
  "thinking",
]);

/**
 * Other apps' audio, lowered while voice listens (ADR 0268): the
 * `voice-quiet` helper (`native/voice-quiet`) runs macOS's voice processing
 * on the microphone voice listens with, and macOS lowers every other sound
 * as it does for a call. It runs only when that microphone is the system's
 * input, and exits when its stdin closes, so it never outlives Work.
 */
export class VoiceQuiet {
  private child: ChildProcess | null = null;
  /** The microphone the helper lowers audio for now; null when it does not. */
  private told: string | null = null;
  /** A microphone the helper cannot lower audio for: it is not asked again. */
  private unavailable: string | null = null;

  constructor(
    private readonly options: {
      helperPath: string;
      spawnImpl?: typeof spawn;
    },
  ) {}

  /**
   * Lower other apps' audio, or let it back up. `microphone` is the label
   * of the microphone voice listens with; nothing is lowered until voice
   * knows it.
   */
  set({
    quiet,
    microphone,
  }: {
    quiet: boolean;
    microphone: string | null;
  }): void {
    const wanted = quiet ? microphone : null;
    if (wanted === this.told) return;
    if (this.told !== null) this.write("loud");
    this.told = null;
    if (!wanted || wanted === this.unavailable) return;
    this.child ??= this.launch();
    this.write(`quiet ${Buffer.from(wanted, "utf8").toString("base64")}`);
    this.told = wanted;
  }

  /** Voice is off: other apps' audio comes back up, and the helper goes. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.told = null;
    this.unavailable = null;
    child?.stdin?.end();
    child?.kill();
  }

  private write(line: string): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${line}\n`);
  }

  private launch(): ChildProcess {
    const child = (this.options.spawnImpl ?? spawn)(
      this.options.helperPath,
      [],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.startsWith("unavailable") && this.child === child) {
          this.unavailable = this.told;
          this.told = null;
        }
        newline = buffered.indexOf("\n");
      }
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.told = null;
    };
    child.once("exit", gone);
    child.once("error", gone);
    // A write to a helper that just exited must not take Work down.
    child.stdin?.on("error", () => {});
    return child;
  }
}
