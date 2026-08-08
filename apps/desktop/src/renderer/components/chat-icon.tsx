import {
  Bell,
  BookOpen,
  Box,
  Bug,
  Calendar,
  ChartLine,
  Cloud,
  Code,
  Compass,
  Database,
  Flame,
  FlaskConical,
  GitBranch,
  GitFork,
  Globe,
  Heart,
  Key,
  Layers,
  Lightbulb,
  type LucideIcon,
  Mail,
  Map as MapIcon,
  MessageSquare,
  Palette,
  Rocket,
  Search,
  Shield,
  Sparkles,
  SquareTerminal,
  Star,
  Target,
  Wrench,
  Zap,
} from "lucide-react";
import {
  CHAT_ICON_COLORS,
  type ChatIconName,
  parseChatIcon,
} from "../../shared/chat-icons.js";

/** Renderer mapping for the shared icon vocabulary (shared/chat-icons.ts). */
const GLYPHS: Record<ChatIconName, LucideIcon> = {
  sparkles: Sparkles,
  zap: Zap,
  rocket: Rocket,
  flame: Flame,
  bug: Bug,
  wrench: Wrench,
  flask: FlaskConical,
  book: BookOpen,
  globe: Globe,
  terminal: SquareTerminal,
  database: Database,
  chart: ChartLine,
  palette: Palette,
  shield: Shield,
  key: Key,
  bell: Bell,
  calendar: Calendar,
  mail: Mail,
  layers: Layers,
  box: Box,
  star: Star,
  lightbulb: Lightbulb,
  target: Target,
  compass: Compass,
  map: MapIcon,
  cloud: Cloud,
  code: Code,
  branch: GitBranch,
  search: Search,
  heart: Heart,
};

/**
 * A conversation's glyph: the agent-chosen icon (tinted with its chosen
 * color), the fork glyph for forked chats without one, or the default
 * chat glyph. One component so bubbles, tabs, docks, and the sidebar
 * agree on what a chat looks like.
 */
export function ChatGlyph({
  icon,
  fork = false,
  className = "size-4",
}: {
  /** The session's stored icon ("<name>:<color>"), if any. */
  icon?: string | null;
  /** The chat is a fork (used when no custom icon is set). */
  fork?: boolean;
  className?: string;
}) {
  const parsed = parseChatIcon(icon);
  if (!parsed) {
    const Fallback = fork ? GitFork : MessageSquare;
    return <Fallback className={className} />;
  }
  const Icon = GLYPHS[parsed.name];
  return (
    <Icon
      className={className}
      style={{ color: CHAT_ICON_COLORS[parsed.color] }}
    />
  );
}

/** True when the stored icon resolves to a custom glyph. */
export function hasCustomChatIcon(icon: string | null | undefined): boolean {
  return parseChatIcon(icon) !== null;
}
