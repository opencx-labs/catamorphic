export interface NodeRendererProps {
  id: string;
  label: string;
  description?: string;
  metadata: Record<string, string>;
  selected: boolean;
}
