/**
 * Subtle notification cues for agent activity: a soft synthesized chime
 * (no audio assets — two quiet sine tones with a fast exponential decay)
 * and, when the window isn't focused, a desktop notification.
 *
 * Sounds are deliberately quiet and short; they mark "the agent needs you /
 * is done", not "something happened". Both channels are user preferences
 * (Settings → Notifications, per profile).
 */

let audioContext: AudioContext | null = null;

const ensureContext = (): AudioContext | null => {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") void audioContext.resume();
    return audioContext;
  } catch {
    return null;
  }
};

const tone = (
  ctx: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  peak: number,
) => {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  // Fast attack, exponential decay — reads as a felt-mallet tap, not a beep.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.05);
};

/**
 * "done": a settled downward third — work finished, nothing is asked of you.
 * "question": a gentle upward second — the agent is waiting on you.
 */
export function playChime(kind: "done" | "question"): void {
  const ctx = ensureContext();
  if (!ctx) return;
  const now = ctx.currentTime + 0.01;
  if (kind === "done") {
    tone(ctx, 659.26, now, 0.28, 0.035); // E5
    tone(ctx, 523.25, now + 0.12, 0.34, 0.03); // C5
  } else {
    tone(ctx, 587.33, now, 0.26, 0.035); // D5
    tone(ctx, 783.99, now + 0.12, 0.36, 0.032); // G5
  }
}

/**
 * Desktop notification, only when the app can't be seen (window unfocused
 * or hidden). Retains the first alert while permission is being granted.
 */
export function notifyDesktop(
  title: string,
  body: string,
  onClick: () => void,
): void {
  if (document.hasFocus()) return;
  try {
    if (Notification.permission === "default") {
      void Notification.requestPermission()
        .then((permission) => {
          if (permission === "granted") notifyDesktop(title, body, onClick);
        })
        .catch(() => {});
      return;
    }
    if (Notification.permission !== "granted") return;
    // silent: the in-app chime is the sound channel; the OS banner is the
    // visual one. Two sounds for one event would be noise.
    const notification = new Notification(title, { body, silent: true });
    notification.onclick = onClick;
  } catch {
    return;
  }
}
