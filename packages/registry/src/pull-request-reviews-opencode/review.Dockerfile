# The review Environment's image, with OpenCode run by Work as an ACP agent.
# The sandbox reaches only the gateway, so OpenCode's configuration is baked
# in here and the pull request's own is ignored.
FROM docker:29.9.3-dind@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121
RUN apk add --no-cache bash curl git jq nodejs npm postgresql-client python3 ripgrep \
  && npm install --global bun@1.4.4 pnpm@12.18.0 opencode-ai@1.19.5
RUN mkdir -p /etc/opencode && printf '%s\n' \
  '{' \
  '  "provider": {' \
  '    "work": {' \
  '      "npm": "@ai-sdk/openai-compatible",' \
  '      "name": "Work gateway",' \
  '      "options": { "baseURL": "{env:WORK_MODEL_BASE_URL}", "apiKey": "{env:WORK_MODEL_API_KEY}" },' \
  '      "models": { "deepseek/deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash" } }' \
  '    }' \
  '  },' \
  '  "model": "work/deepseek/deepseek-v4.1-flash",' \
  '  "small_model": "work/deepseek/deepseek-v4.1-flash",' \
  '  "permission": { "edit": "allow", "bash": "allow", "webfetch": "deny" },' \
  '  "autoupdate": false,' \
  '  "share": "disabled"' \
  '}' > /etc/opencode/work.json
ENV OPENCODE_CONFIG=/etc/opencode/work.json \
  OPENCODE_DISABLE_PROJECT_CONFIG=1 \
  OPENCODE_DISABLE_AUTOUPDATE=1 \
  OPENCODE_DISABLE_MODELS_FETCH=1
WORKDIR /workspace
