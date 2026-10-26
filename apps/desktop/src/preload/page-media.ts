/** Revoke page-owned capture, including clones that outlive its first stream. */
export function installPageMedia(): void {
  type Kind = "microphone" | "camera" | "screenShare";
  const host = (
    window as unknown as {
      __workPageMedia: {
        onRevoke(listener: (kind: Kind) => void): void;
      };
    }
  ).__workPageMedia;
  const devices = navigator.mediaDevices;
  if (!devices) return;
  // Revocation must not keep a page's abandoned track alive.
  const captureKind = Symbol.for("work.media.capture-kind");
  const tracks = new Map<WeakRef<MediaStreamTrack>, Kind>();
  const references = new WeakMap<MediaStreamTrack, WeakRef<MediaStreamTrack>>();
  const revoked: Record<Kind, number> = {
    microphone: 0,
    camera: 0,
    screenShare: 0,
  };
  const nativeStop = MediaStreamTrack.prototype.stop;
  const nativeClone = MediaStreamTrack.prototype.clone;
  const Stream = MediaStream;
  const streamTracks = MediaStream.prototype.getTracks;
  const finalized = new FinalizationRegistry<WeakRef<MediaStreamTrack>>(
    (ref) => {
      tracks.delete(ref);
    },
  );
  const forget = (track: MediaStreamTrack) => {
    const ref = references.get(track);
    if (!ref) return;
    tracks.delete(ref);
    references.delete(track);
    finalized.unregister(ref);
  };
  const kindOf = (track: MediaStreamTrack): Kind | undefined => {
    // A same-origin frame/window can clone a track through another realm's
    // MediaStream prototype. The source kind travels with the track, with
    // no reference that could retain its frame or source.
    const kind = (track as unknown as Record<symbol, unknown>)[captureKind];
    return kind === "microphone" || kind === "camera" || kind === "screenShare"
      ? kind
      : undefined;
  };
  const remember = (track: MediaStreamTrack, kind: Kind) => {
    if (track.readyState !== "live" || references.has(track)) return;
    if (!kindOf(track))
      Object.defineProperty(track, captureKind, { value: kind });
    const ref = new WeakRef(track);
    tracks.set(ref, kind);
    references.set(track, ref);
    finalized.register(track, ref, ref);
    // An ended/mute listener pins a live track by the capture spec.
    // Revocation needs only this weak reference, with no track listeners.
  };
  // Explicit stop does not fire `ended` (Media Capture and Streams).
  MediaStreamTrack.prototype.stop = function () {
    nativeStop.call(this);
    if (references.has(this)) forget(this);
  };
  MediaStreamTrack.prototype.clone = function () {
    const clone = nativeClone.call(this),
      kind = kindOf(this);
    if (kind) remember(clone, kind);
    return clone;
  };
  MediaStream.prototype.clone = function () {
    const clone = new Stream(
      streamTracks.call(this).map((track) => {
        const copy = nativeClone.call(track),
          kind = kindOf(track);
        if (kind) remember(copy, kind);
        return copy;
      }),
    );
    return clone;
  };
  const received = (
    stream: MediaStream,
    display: boolean,
    epoch: Record<Kind, number>,
  ) => {
    for (const track of stream.getTracks()) {
      const kind: Kind = display
        ? "screenShare"
        : track.kind === "audio"
          ? "microphone"
          : "camera";
      if (revoked[kind] !== epoch[kind]) nativeStop.call(track);
      else remember(track, kind);
    }
    return stream;
  };
  const capture = async (
    request: Promise<MediaStream>,
    display: boolean,
    epoch: Record<Kind, number>,
  ) => received(await request, display, epoch);
  const userMedia = devices.getUserMedia;
  devices.getUserMedia = function (constraints) {
    const epoch = { ...revoked };
    return capture(userMedia.call(this, constraints), false, epoch);
  };
  const displayMedia = devices.getDisplayMedia;
  devices.getDisplayMedia = function (constraints) {
    const epoch = { ...revoked };
    return capture(displayMedia.call(this, constraints), true, epoch);
  };
  // Chromium's callback entry points acquire independently of mediaDevices.
  // Observe the APIs it already provides, with the same native callbacks.
  type LegacyCapture = (
    constraints: MediaStreamConstraints,
    success: (stream: MediaStream) => void,
    failure: (error: DOMException) => void,
  ) => void;
  const legacy = navigator as Navigator & {
    getUserMedia?: LegacyCapture;
    webkitGetUserMedia?: LegacyCapture;
  };
  for (const name of ["getUserMedia", "webkitGetUserMedia"] as const) {
    const native = legacy[name];
    if (!native) continue;
    legacy[name] = function (constraints, success, failure) {
      const epoch = { ...revoked };
      return native.call(
        this,
        constraints,
        (stream) => success(received(stream, false, epoch)),
        failure,
      );
    };
  }
  host.onRevoke((kind) => {
    if (!Object.hasOwn(revoked, kind)) return;
    revoked[kind]++;
    for (const [ref, capture] of tracks)
      if (capture === kind) {
        const track = ref.deref();
        if (track) {
          nativeStop.call(track);
          forget(track);
        }
      }
  });
}
