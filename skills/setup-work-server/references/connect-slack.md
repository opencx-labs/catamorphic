# Connect Slack

Use this when a project should answer people in Slack: a mention of the app
starts (or continues) a project chat for that thread, the agent reads the
thread through the gateway, and its answer is posted back to the thread
(#117, ADR 0179). Everything Slack-specific is project code from the host
skill `slack`; this page is the server side: the Slack app, the gateway
entry, the service connection, and the secret.

You need a Work server Slack can reach over HTTPS (`WORK_PUBLIC_URL`), an
organization administrator, and someone who manages the project
(`automations:write`, `secrets:write`, `webhooks:read`).

## 1. Create the Slack app from a manifest

In Slack, **Create New App**, **From a manifest**, pick the workspace, and
paste:

```yaml
display_information:
  name: Work
  description: The company brain, in your threads
features:
  bot_user:
    display_name: Work
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - im:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The Request URL comes later, once the project listens (step 5). Add
`message.channels`, `message.groups`, and `message.im` to `bot_events` only
for workflows that react to every message (`slack.message`); mentions need
only `app_mention`.

Then **Install to Workspace**. Keep two values, and paste neither into a chat,
a repository, or a command line an agent can read:

- **Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions): the `slack`
  service connection.
- **Signing Secret** (Basic Information, App Credentials): the project secret
  `SLACK_SIGNING_SECRET`.

## 2. Declare the gateway entry

Add Slack to the file `WORK_GATEWAY_CONFIG` names and restart the server. Each
Web API method is a named action with a fixed method and path, so bindings
grant methods, not "any POST":

```json
{
  "connections": [
    {
      "type": "http", "kind": "slack", "displayName": "Slack",
      "baseUrl": "https://slack.com/api",
      "actions": [
        { "name": "conversations.history", "method": "get", "path": "/conversations.history", "description": "Read a conversation's messages" },
        { "name": "conversations.replies", "method": "get", "path": "/conversations.replies", "description": "Read a thread" },
        { "name": "chat.postMessage", "method": "post", "path": "/chat.postMessage", "description": "Post a message or a thread reply" },
        { "name": "chat.getPermalink", "method": "get", "path": "/chat.getPermalink", "description": "Link to one message" },
        { "name": "users.info", "method": "get", "path": "/users.info", "description": "Look up a person" },
        { "name": "search.messages", "method": "get", "path": "/search.messages", "description": "Search messages (user token only)" }
      ]
    }
  ],
  "guards": [
    { "type": "approval", "name": "slack-posts", "kinds": ["slack"], "actions": ["chat.postMessage"] }
  ]
}
```

The approval guard is optional: it makes an agent ask its person before
posting anywhere, and refuses posts from workflows, so leave it out when the
reply automation should post on its own. Guards can name any action.

## 3. Connect the bot token

An organization administrator creates the service connection and enters the
token through the provider's form (see
[service connections](secrets-and-gateway.md#service-connections-and-administrators)):

1. `POST /api/service-connections` with `{ "name": "slack", "providerKind":
   "slack" }` (add `"principalKind": "project_service"` and `"projectId"` for
   one project only).
2. `POST /api/service-connections/:id/authorize`, then complete the form with
   the bot token as the API key, in the app or with `POST
   /api/connection-authorizations/complete`.

The token lives in the vault; workers, sandboxes, and workflows never see it.

**Search** (`search.messages`) refuses bot tokens. Add a Slack **user** token
scope `search:read`, reinstall, and connect that user's `xoxp-…` token as a
second service connection named `slack-search` on the same `slack` kind; it
finds what that Slack account can see, so use an account meant for it.
Members may instead connect their own token when a binding says
`"principal": "member"`, for their own chats only.

**Slack's MCP server** is an alternative for people rather than automations:
an `mcp` entry (`"url": "https://mcp.slack.com/mcp"`) with Slack's
pre-registered client in `oauth.client`, bound with `"principal": "member"`.
Register `<WORK_PUBLIC_URL>/api/connection-authorizations/callback` as its
redirect URL.

## 4. Commit the project side

From the `slack` skill, commit to the project and publish:

- `.work/triggers/slack.ts`: the trigger library (signature check, URL
  verification, event ids as delivery ids, `slack.mention`, `slack.message`).
- `.work/agents/slack.json` (and optional `slack.md`): the agent that answers
  in threads, allowed to read Slack but not post.
- The two workflows: answer mentions, post replies.
- In `.work/project.json`, the binding for the Environment those automations
  and chats use:

```json
{
  "environments": {
    "default": {
      "workloads": ["agent", "workflow"],
      "connections": {
        "slack": {
          "provider": "slack", "principal": "service", "service": "slack",
          "capabilities": ["conversations.history", "conversations.replies", "chat.postMessage", "chat.getPermalink", "users.info"]
        }
      }
    }
  },
  "defaultEnvironment": "default"
}
```

Set the project secret `SLACK_SIGNING_SECRET` to the Signing Secret
(`PUT /api/projects/:id/secrets/SLACK_SIGNING_SECRET`, or the project's
secrets page). The trigger library declares it with `use: "webhook"`, which
is what lets the project store it: the control plane verifies deliveries
with it, and no workflow run or agent ever receives it. The bot token is not
a project secret either; it stays behind the `slack` connection.

## 5. Turn it on, then point Slack at it

1. Enable both workflows for the project (someone with `automations:write`),
   consenting to the `slack` connection.
2. Copy the `slack` webhook URL from the workflow's **Automatic** view (or
   `GET /api/projects/:id/webhooks`). It answers only once an enabled
   workflow listens.
3. In the Slack app, **Event Subscriptions**, turn events on and paste the
   URL as the Request URL. Slack sends `url_verification`; the server checks
   the signature and answers the challenge at once.
4. Invite the app to each channel it should hear: `/invite @Work`.

## 6. Verify

- Mention the app in a channel thread. A project chat keyed
  `slack:<channel>:<thread_ts>` appears for everyone in the project, and the
  agent's answer arrives in the thread.
- Mention it again in the same thread: the same chat continues.
- The webhook's deliveries show one stored event per Slack `event_id`, even
  when Slack retried (`x-slack-retry-num`).
- The connection audit lists each `conversations.replies` and
  `chat.postMessage` call, attributed to the project.

If nothing arrives: a `401` means the signing secret does not match or the
server clock is off by more than five minutes; a `404` means no enabled
workflow listens on `slack`; `not_in_channel` in a run means the app was not
invited; `missing_scope` means the manifest lacks a scope (reinstall after
adding it).

Everyone in a thread shares one chat and the agent answers every mention.
Letting the agent stay quiet while people talk to each other is group chat
work (#92). Slack users become project members only where the project links
them in its workflow; otherwise they appear as Slack users.
