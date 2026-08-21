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
} from "../lib/chat-icons.js";

/** Mapping for the shared icon vocabulary (lib/chat-icons.ts — mirrors
 * the desktop's components/chat-icon.tsx). */
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

export function ChatGlyph({
  icon,
  fork = false,
  className = "size-4",
}: {
  icon?: string | null;
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
