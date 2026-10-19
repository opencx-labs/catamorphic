// .work/triggers/slack.ts
import {
  defineSecrets,
  defineTrigger,
  type Narrow,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

/** The Slack app's signing secret (Basic Information, App Credentials). */
export const slackSecrets = defineSecrets({
  // Verifies Slack's deliveries on the server; runs never receive it.
  SLACK_SIGNING_SECRET: { label: "Slack signing secret", use: "webhook" },
});

/** A message as Slack sends it in app_mention and message events. */
export interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackEventCallback {
  type: "event_callback";
  team_id: string;
  api_app_id: string;
  event_id: string;
  event_time: number;
  event: SlackMessage;
}

type SlackDelivery = Narrow<
  TriggerPayload<"webhook">,
  { payload: { body: SlackEventCallback } }
>;

/** Every signed event from the Slack app, each stored once. */
export const slackEvent = defineTrigger<SlackDelivery>({
  name: "slack.event",
  description: "An event from the Slack app",
  from: trigger("webhook", {
    name: "slack",
    verify: {
      scheme: "hmac",
      secret: "SLACK_SIGNING_SECRET",
      header: "x-slack-signature",
      prefix: "v0=",
      content: "v0:{timestamp}:{body}",
      timestamp: { header: "x-slack-request-timestamp", toleranceSeconds: 300 },
    },
    respond: [
      { when: { body: { type: "url_verification" } }, echo: "body.challenge" },
    ],
    deliveryId: "body.event_id",
  }),
  where: { payload: { body: { type: "event_callback" } } },
});

/** A person mentioned the app. */
export const slackMention = defineTrigger<SlackDelivery>({
  name: "slack.mention",
  description: "A person mentioned the Slack app",
  from: trigger("slack.event"),
  where: {
    payload: {
      body: { event: { type: "app_mention", bot_id: { $exists: false } } },
    },
  },
});

/** A person posted where the app is a member: no edits, joins, or bots. */
export const slackMessage = defineTrigger<SlackDelivery>({
  name: "slack.message",
  description:
    "A person posted a message in a conversation the Slack app is in",
  from: trigger("slack.event"),
  where: {
    payload: {
      body: {
        event: {
          type: "message",
          subtype: { $exists: false },
          bot_id: { $exists: false },
        },
      },
    },
  },
});
