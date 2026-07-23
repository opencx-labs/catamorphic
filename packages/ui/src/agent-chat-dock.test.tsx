import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentChatDock } from "./agent-chat-dock.js";

const messages = [
  { id: "1", role: "user" as const, content: "Change the workflow" },
  { id: "2", role: "assistant" as const, content: "Updated the workflow" },
];

describe("AgentChatDock", () => {
  it("keeps the collapsed dock focused on the composer", () => {
    render(
      <AgentChatDock
        messages={messages}
        collapsedSummary="Edited src/workflow.ts"
        onSend={() => {}}
      />,
    );

    expect(screen.getByText("Edited src/workflow.ts")).toHaveClass(
      "catamorphic-agent-dock-live",
    );
    expect(
      screen.getByText("Change the workflow").closest("[aria-hidden]"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByText("Updated the workflow").closest("[aria-hidden]"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByLabelText("Message the coding agent"),
    ).toBeInTheDocument();
  });

  it("expands to show conversation history", () => {
    render(<AgentChatDock messages={messages} onSend={() => {}} />);

    fireEvent.click(screen.getByLabelText("Expand conversation"));

    expect(screen.getByText("Change the workflow")).toBeInTheDocument();
    expect(screen.getAllByText("Updated the workflow")).toHaveLength(2);
    expect(screen.getByLabelText("Collapse conversation")).toBeInTheDocument();
  });

  it("shows submitted activity immediately while send is unresolved", async () => {
    let resolveSend: (() => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<AgentChatDock messages={[]} onSend={onSend} />);
    const composer = screen.getByLabelText("Message the coding agent");

    fireEvent.change(composer, { target: { value: "Update it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(screen.getByLabelText("Send message")).toBeDisabled();
    expect(screen.getAllByText("Agent is working")).toHaveLength(2);
    resolveSend?.();
    await waitFor(() => expect(composer).toHaveValue(""));
  });

  it("keeps in-progress assistant content in the working state", () => {
    const { rerender } = render(
      <AgentChatDock
        messages={[
          {
            id: "pending",
            role: "assistant",
            content: "Thinking...",
            metadata: { status: "in_progress" },
          },
        ]}
        defaultExpanded
        onSend={() => {}}
      />,
    );

    expect(screen.getAllByText("Thinking...")).toHaveLength(2);
    expect(document.querySelectorAll("article")).toHaveLength(0);

    rerender(
      <AgentChatDock
        messages={[
          {
            id: "pending",
            role: "assistant",
            content: "Updated the workflow",
            metadata: { status: "completed" },
          },
        ]}
        defaultExpanded
        onSend={() => {}}
      />,
    );

    expect(screen.getByRole("article")).toHaveTextContent(
      "Updated the workflow",
    );
    expect(screen.getByRole("article")).toHaveClass(
      "catamorphic-agent-dock-message",
    );
  });

  it("submits a trimmed message and clears the composer", async () => {
    const onSend = vi.fn(async () => {});
    render(<AgentChatDock messages={[]} onSend={onSend} />);
    const composer = screen.getByLabelText("Message the coding agent");

    fireEvent.change(composer, { target: { value: "  Add a retry  " } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Add a retry"));
    expect(screen.getByLabelText("Collapse conversation")).toBeInTheDocument();
    expect(composer).toHaveValue("");
  });

  it("preserves the draft when sending fails", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("Agent unavailable");
    });
    render(<AgentChatDock messages={[]} onSend={onSend} />);
    const composer = screen.getByLabelText("Message the coding agent");

    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() =>
      expect(screen.getAllByText("Agent unavailable")).toHaveLength(2),
    );
    expect(composer).toHaveValue("Keep this draft");
  });
});
