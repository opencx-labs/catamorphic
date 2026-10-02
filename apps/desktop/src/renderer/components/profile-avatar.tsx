import type { Profile } from "../lib/desktop-api";

const SIZES = {
  sm: "size-4 text-[10px]",
  md: "size-5 text-xs",
  lg: "size-8 text-sm",
} as const;

/** A profile's initial on its color: the same mark wherever a profile shows. */
export function ProfileAvatar({
  profile,
  size = "md",
}: {
  profile: Pick<Profile, "name" | "color">;
  size?: keyof typeof SIZES;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-medium ring-1 ring-fg/10 ${SIZES[size]}`}
      style={{
        color: profile.color,
        backgroundColor: `color-mix(in srgb, ${profile.color} 12%, var(--color-bg-raised))`,
      }}
    >
      {profile.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
