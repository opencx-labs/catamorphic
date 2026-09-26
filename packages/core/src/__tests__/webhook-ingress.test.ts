import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  matchWebhookHandshake,
  verifyWebhookRequest,
  type WebhookRequest,
  type WebhookVerify,
  webhookConfig,
  webhookSettingsKey,
} from "../webhook-ingress.js";

function request(input: {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
  method?: string;
}): WebhookRequest {
  return {
    method: input.method ?? "POST",
    headers: input.headers ?? {},
    query: input.query ?? {},
    body: Buffer.from(input.body ?? ""),
  };
}

function verify(input: {
  verify: WebhookVerify;
  request: WebhookRequest;
  secret: string;
  now?: Date;
}) {
  return verifyWebhookRequest({ now: new Date(), ...input });
}

/** Parses a verify block the way a binding's config is validated. */
function scheme(value: object): WebhookVerify {
  const parsed = webhookConfig.parse({ name: "hook", verify: value });
  if (!parsed.verify) throw new Error("verify missing");
  return parsed.verify;
}

describe("webhook verification schemes", () => {
  // docs.github.com, "Validating webhook deliveries": test values.
  it("GitHub: HMAC-SHA256 of the body, sha256= prefix, hex", () => {
    const github = scheme({
      scheme: "hmac",
      secret: "GITHUB_WEBHOOK_SECRET",
      header: "x-hub-signature-256",
      prefix: "sha256=",
    });
    const signature =
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(
      verify({
        verify: github,
        secret: "It's a Secret to Everybody",
        request: request({
          headers: { "x-hub-signature-256": signature },
          body: "Hello, World!",
        }),
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        verify: github,
        secret: "It's a Secret to Everybody",
        request: request({
          headers: { "x-hub-signature-256": signature },
          body: "Hello, World?",
        }),
      }),
    ).toEqual({ ok: false, reason: "Signature does not match" });
    // The legacy SHA-1 header is the same scheme with another algorithm.
    const sha1 = crypto
      .createHmac("sha1", "It's a Secret to Everybody")
      .update("Hello, World!")
      .digest("hex");
    expect(
      verify({
        verify: scheme({
          scheme: "hmac",
          secret: "GITHUB_WEBHOOK_SECRET",
          algorithm: "sha1",
          header: "x-hub-signature",
          prefix: "sha1=",
        }),
        secret: "It's a Secret to Everybody",
        request: request({
          headers: { "x-hub-signature": `sha1=${sha1}` },
          body: "Hello, World!",
        }),
      }),
    ).toEqual({ ok: true });
  });

  // api.slack.com, "Verifying requests from Slack": the worked example.
  it("Slack: v0:{timestamp}:{body} with a five-minute window", () => {
    const slack = scheme({
      scheme: "hmac",
      secret: "SLACK_SIGNING_SECRET",
      header: "x-slack-signature",
      prefix: "v0=",
      content: "v0:{timestamp}:{body}",
      timestamp: { header: "x-slack-request-timestamp", toleranceSeconds: 300 },
    });
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    const signed = request({
      headers: {
        "x-slack-request-timestamp": "1531420618",
        "x-slack-signature":
          "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
      },
      body,
    });
    const secret = "8f742231b10e8888abcd99yyyzzz85a5";
    expect(
      verify({
        verify: slack,
        secret,
        request: signed,
        now: new Date(1531420618_000 + 299_000),
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        verify: slack,
        secret,
        request: signed,
        now: new Date(1531420618_000 + 301_000),
      }),
    ).toEqual({ ok: false, reason: "Timestamp outside the tolerance window" });
    expect(
      verify({
        verify: slack,
        secret,
        request: {
          ...signed,
          headers: { ...signed.headers, "x-slack-request-timestamp": "" },
        },
      }),
    ).toEqual({ ok: false, reason: "Missing timestamp" });
  });

  // github.com/standard-webhooks/standard-webhooks, spec test vector.
  it("Standard Webhooks: id.timestamp.body, base64 whsec_ key, several signatures", () => {
    const standard = scheme({
      scheme: "hmac",
      secret: "WEBHOOK_SECRET",
      header: "webhook-signature",
      encoding: "base64",
      pattern: "v1,([A-Za-z0-9+/=]+)",
      content: "{header:webhook-id}.{timestamp}.{body}",
      timestamp: { header: "webhook-timestamp" },
      secretEncoding: "base64",
      secretPrefix: "whsec_",
    });
    const signed = request({
      headers: {
        "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
        "webhook-timestamp": "1614265330",
        "webhook-signature":
          "v1,rotated0000000000000000000000000000000000= v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      },
      body: '{"test": 2432232314}',
    });
    expect(
      verify({
        verify: standard,
        secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        request: signed,
        now: new Date(1614265330_000),
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        verify: standard,
        secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        request: {
          ...signed,
          headers: { ...signed.headers, "webhook-id": "msg_other" },
        },
        now: new Date(1614265330_000),
      }),
    ).toEqual({ ok: false, reason: "Signature does not match" });
  });

  // docs.stripe.com, "Verify webhook signatures manually": t={t},v1={hmac of
  // "{t}.{body}"} in one header. Signed here with the documented recipe.
  it("Stripe: timestamp and signatures extracted from one header", () => {
    const stripe = scheme({
      scheme: "hmac",
      secret: "STRIPE_WEBHOOK_SECRET",
      header: "stripe-signature",
      pattern: "v1=([0-9a-f]+)",
      content: "{timestamp}.{body}",
      timestamp: { header: "stripe-signature", pattern: "t=(\\d+)" },
    });
    const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
    const t = "1700000000";
    const v1 = crypto
      .createHmac("sha256", "whsec_stripe")
      .update(`${t}.${body}`)
      .digest("hex");
    expect(
      verify({
        verify: stripe,
        secret: "whsec_stripe",
        request: request({
          headers: { "stripe-signature": `t=${t},v1=${v1},v0=deadbeef` },
          body,
        }),
        now: new Date(Number(t) * 1000),
      }),
    ).toEqual({ ok: true });
  });

  // shopify.dev, "Verify webhooks": base64 HMAC-SHA256 of the raw body.
  it("Shopify: base64 digest of the body", () => {
    const body = '{"id":820982911946154508}';
    const digest = crypto
      .createHmac("sha256", "shpss_secret")
      .update(body)
      .digest("base64");
    expect(
      verify({
        verify: scheme({
          scheme: "hmac",
          secret: "SHOPIFY_SECRET",
          header: "x-shopify-hmac-sha256",
          encoding: "base64",
        }),
        secret: "shpss_secret",
        request: request({
          headers: { "x-shopify-hmac-sha256": digest },
          body,
        }),
      }),
    ).toEqual({ ok: true });
  });

  // linear.app/developers/webhooks: hex HMAC-SHA256 of the body.
  it("Linear: hex digest without a prefix, upper-case accepted", () => {
    const body = '{"action":"create","type":"Issue"}';
    const digest = crypto
      .createHmac("sha256", "lin_wh_secret")
      .update(body)
      .digest("hex")
      .toUpperCase();
    expect(
      verify({
        verify: scheme({
          scheme: "hmac",
          secret: "LINEAR_SECRET",
          header: "linear-signature",
        }),
        secret: "lin_wh_secret",
        request: request({ headers: { "linear-signature": digest }, body }),
      }),
    ).toEqual({ ok: true });
  });

  // docs.gitlab.com, "Webhooks": the secret token arrives in X-Gitlab-Token.
  it("GitLab: a shared token in a header, or any token in the query", () => {
    const gitlab = scheme({
      scheme: "token",
      secret: "GITLAB_TOKEN",
      header: "X-Gitlab-Token",
    });
    expect(
      verify({
        verify: gitlab,
        secret: "s3cret",
        request: request({ headers: { "x-gitlab-token": "s3cret" } }),
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        verify: gitlab,
        secret: "s3cret",
        request: request({ headers: { "x-gitlab-token": "s3cre" } }),
      }),
    ).toEqual({ ok: false, reason: "Token does not match" });
    expect(
      verify({
        verify: scheme({ scheme: "token", secret: "HOOK_TOKEN", query: "key" }),
        secret: "s3cret",
        request: request({ query: { key: "s3cret" } }),
      }),
    ).toEqual({ ok: true });
  });

  it("rejects configurations that could never verify", () => {
    const problems = (value: object) => {
      const parsed = webhookConfig.safeParse({ name: "hook", ...value });
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) => issue.message);
    };
    expect(
      problems({
        verify: { scheme: "hmac", secret: "S", header: "h", content: "{nope}" },
      }),
    ).toEqual([
      "Unknown placeholder {nope}; use {body}, {timestamp} or {header:<name>}",
    ]);
    expect(
      problems({
        verify: {
          scheme: "hmac",
          secret: "S",
          header: "h",
          content: "{timestamp}.{body}",
        },
      }),
    ).toEqual(["{timestamp} needs a timestamp source"]);
    expect(
      problems({
        verify: {
          scheme: "hmac",
          secret: "S",
          header: "h",
          pattern: "v1=[a-f]+",
        },
      }),
    ).toEqual(["Use exactly one capture group"]);
    expect(problems({ verify: { scheme: "token", secret: "S" } })).toEqual([
      "Name exactly one of header or query",
    ]);
    expect(
      problems({
        respond: [{ when: { body: [{ a: 1 }] }, echo: "body.challenge" }],
      }),
    ).toEqual([
      "when.body lists values to match; each must be a string, number, boolean or null",
    ]);
    expect(problems({ respond: [{ when: {}, echo: "challenge" }] })).toEqual([
      "Name a value under body, query or headers",
    ]);
  });

  it("compares settings independent of key order", () => {
    const a = webhookConfig.parse({
      name: "hook",
      verify: { scheme: "hmac", secret: "S", header: "h", prefix: "p" },
    });
    const b = webhookConfig.parse({
      verify: { prefix: "p", header: "h", secret: "S", scheme: "hmac" },
      name: "hook",
    });
    expect(webhookSettingsKey(a)).toBe(webhookSettingsKey(b));
  });
});

describe("webhook handshakes", () => {
  const rules =
    webhookConfig.parse({
      name: "hook",
      respond: [
        {
          when: { body: { type: "url_verification" } },
          echo: "body.challenge",
        },
        {
          when: { method: "GET", query: { "hub.mode": "subscribe" } },
          echo: "query.hub.challenge",
        },
        {
          when: { query: { validationToken: { exists: true } } },
          echo: "query.validationToken",
        },
      ],
    }).respond ?? [];

  it("echoes a body value (Slack url_verification)", () => {
    expect(
      matchWebhookHandshake({
        rules,
        request: request({}),
        body: { type: "url_verification", challenge: "3eZbrw1aBm" },
      })?.answer,
    ).toBe("3eZbrw1aBm");
  });

  it("echoes a dotted query parameter on GET (Meta hub.challenge)", () => {
    expect(
      matchWebhookHandshake({
        rules,
        request: request({
          method: "get",
          query: { "hub.mode": "subscribe", "hub.challenge": "1158201444" },
        }),
        body: "",
      })?.answer,
    ).toBe("1158201444");
  });

  it("echoes a query parameter on POST (Microsoft Graph validationToken)", () => {
    expect(
      matchWebhookHandshake({
        rules,
        request: request({ query: { validationToken: "Validation: Token" } }),
        body: "",
      })?.answer,
    ).toBe("Validation: Token");
  });

  it("lets ordinary deliveries through, and skips rules without a value", () => {
    expect(
      matchWebhookHandshake({
        rules,
        request: request({}),
        body: { type: "event_callback" },
      }),
    ).toBeUndefined();
    expect(
      matchWebhookHandshake({
        rules,
        request: request({}),
        body: { type: "url_verification" },
      }),
    ).toBeUndefined();
  });
});
