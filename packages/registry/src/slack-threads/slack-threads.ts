import {
  type BoundaryContext,
  defineWorkflow,
  type SessionHistoryMessage,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

/** Slack user ids of project members the project chooses to link. */
const SLACK_MEMBERS: Record<string, string> = {};

/** @displayname Answer Slack mentions */
export const answerSlackMentions = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("slack.mention")],
  connections: [
    {
      alias: "slack",
      principal: "service",
      capabilities: [
        "conversations.history",
        "conversations.replies",
        "users.info",
        "chat.getPermalink",
      ],
    },
  ],
  steps: [
    /** @displayname Hand the mention to the thread's chat */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<TriggerPayload<"slack.mention">>) => {
        const { event, event_id: eventId } = input.payload.body;
        const thread = event.thread_ts ?? event.ts;
        const member = event.user ? SLACK_MEMBERS[event.user] : undefined;
        const author = member
          ? `Project member ${member}`
          : `Slack user <@${event.user ?? "unknown"}>`;
        return host["catamorphic.sessions"].deliver({
          key: `slack:${event.channel}:${thread}`,
          agentSlug: "slack",
          title: `Slack: ${(event.text ?? "mention").slice(0, 60)}`,
          content: [
            author +
              " mentioned you in Slack (channel " +
              event.channel +
              ", thread " +
              thread +
              "):",
            event.text ?? "",
            "Read the thread with the slack connection's conversations.replies first. Answer here: your reply is posted to the thread.",
          ].join("\n\n"),
          idempotencyKey: `slack:${eventId}`,
        });
      },
    }),
  ],
}));

type SettledReply = {
  sessionId: string;
  key: string | null;
  messages: SessionHistoryMessage[];
};

/** @displayname Post replies to Slack threads */
export const postSlackReplies = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("session.turn-changed", {
      statuses: ["completed"],
      where: { payload: { session: { key: { $prefix: "slack:" } } } },
    }),
  ],
  connections: [
    {
      alias: "slack",
      principal: "service",
      capabilities: ["chat.postMessage"],
    },
  ],
  steps: [
    /** @displayname Read the settled reply */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<TriggerPayload<"session.turn-changed">>) => {
        const reply = input.payload.detail.resultMessageId;
        if (typeof reply !== "string") {
          const quiet: SettledReply = {
            sessionId: input.payload.sessionId,
            key: null,
            messages: [],
          };
          return quiet;
        }
        return host["catamorphic.sessions"].history({
          sessionId: input.payload.sessionId,
          through: reply,
          limit: 1,
        });
      },
    }),
    /** @displayname Post it in the thread */
    defineBoundary({
      run: ({ input, connections }: BoundaryContext<SettledReply>) => {
        const [, channel, threadTs] =
          /^slack:([^:]+):(.+)$/.exec(input.key ?? "") ?? [];
        const reply = input.messages.at(-1);
        if (
          !channel ||
          !threadTs ||
          reply?.role !== "assistant" ||
          !reply.content.trim()
        ) {
          return { posted: false };
        }
        return connections.slack.chat.postMessage({
          body: {
            channel,
            thread_ts: threadTs,
            markdown_text: reply.content.slice(0, 12000),
          },
        });
      },
    }),
  ],
}));
