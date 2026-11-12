# Example firegoat tests

Product names are fictional. Copy the shape, not the words.

## Problem-first prompts: bad vs good

The bad prompt hands the agent the answer; the good one is what the user actually types.

| Product | Bad (explicit) | Good (the user's problem) |
| --- | --- | --- |
| Email API / SDK | "Use Acme's SDK to send a welcome email via POST /emails." | "New users who sign up on my app should get a welcome email." |
| Deploy CLI | "Run `acme deploy --prod` to deploy this app to Acme." | "I want this app online at a link I can send to a friend." |
| Validation library | "Use acme-validate's `object()` schema to validate the signup form." | "People keep submitting the signup form with junk emails and empty names. Make it reject those with a clear message." |
| Error-monitoring web app | "Create a project on app.acme.dev and call `Acme.init()` with its DSN." | "My app crashes sometimes in production and I only find out when users complain." |

## Good

### 1. Zero-start (the one test with no context)

Exactly one per suite: nothing installed, no keys, no product name, no docs. It shows how an agent
meets the product cold, like the [AX tier list](https://firegoat.ai/axlist): does it find Acme,
can it start without a human, and when it needs a key, do the errors say what to do? Passing
means solved hands-off, or stopped at the first real blocker with the one step left for the user.
In a suite with a `build:`, the build's install goes on the configured tests' own `install:`,
never the top-level one: that runs for zero-start too. `env_passthrough: [PATH]` keeps
`$FIREGOAT_OUT` off its PATH; the user's shell env (their `ACME_API_KEY`) never reaches it.
If acme is installed globally on this machine, the agent will find it: say so in the report
(or uninstall it first).

```yaml
tests:
  - name: zero-start
    env_passthrough: [PATH]        # the user's PATH, without $FIREGOAT_OUT
    prompt: >-
      I need to run some untrusted Python my users upload, somewhere that isn't my
      machine. Get print('hello from a sandbox') running remotely and show me the output. Keep it minimal.
    end_goal: >-
      Either the snippet's output comes back from an Acme sandbox with no human step,
      or the agent stops at the first blocker and tells the user exactly what is
      missing (ACME_API_KEY, and where to create one) instead of guessing or faking it.
    checks:
      - run: >-
          test -s "$FIREGOAT_TRANSCRIPT" &&
          grep -Eqi 'acme' "$FIREGOAT_TRANSCRIPT"
      - run: grep -Eq 'hello from a sandbox|ACME_API_KEY' "$FIREGOAT_ANSWER"
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
    timeout: 900
```

The final-answer check only proves the answer mentions one of them; whether it says the right
thing about it ("set ACME_API_KEY", not "you don't need ACME_API_KEY") is the end_goal, read by
you. In the report, give its AX tier list placement on its own labeled line (S hands-off, A just
confirm, B copy a key, C figure it out, D blocked), separate from the checks tier eval prints, and
quote the error or doc line that helped or stopped it.

### 2. Problem-first, product found from context

Same sandbox product, but the prompt is the user's problem. The installed package and the
key the user exports (passed through by name) are the only pointers, as in a real project.

```yaml
build: uv build --wheel --out-dir "$FIREGOAT_OUT"
tests:
  - name: run-untrusted-code
    prompt: >-
      Users of my app can paste Python snippets and I want to run them, but not on my
      server. Show me it works with a snippet that prints hello-sandbox, and don't
      leave anything running afterwards. API keys are in the env. Keep it minimal.
    install: uv venv && uv pip install "$FIREGOAT_OUT"/*.whl
    env_passthrough: [ACME_API_KEY]
    end_goal: >-
      A script runs the snippet in an Acme sandbox via the installed SDK, prints
      hello-sandbox, and deletes the sandbox at the end.
    checks:
      - run: grep -rqE '^\s*(from|import) acme' "$FIREGOAT_WORKDIR" --include='*.py'
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
```

### 3. A workflow, described as the pain it removes

```yaml
tests:
  - name: support-triage
    prompt: >-
      Our support inbox is drowning. For each incoming message I want to know what
      kind of issue it is, how urgent it is, and have a reply drafted. Try it on a
      customer asking for a refund and show me the result. Keep it minimal.
    end_goal: >-
      An Acme workflow runs once on a refund request and prints the issue type, a
      priority and a drafted reply.
    checks:
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
```

### 4. Discovery from shipped docs

The docs are copied into the folder; the last check makes sure the agent didn't go into the repo
(`$FIREGOAT_REPO`) instead, as on every test.

```yaml
build: cp -R docs "$FIREGOAT_OUT/acme-docs"
install: cp -R "$FIREGOAT_OUT/acme-docs" docs
tests:
  - name: which-packages
    prompt: >-
      I'm building a mobile app. It needs a local database, maps, age gating,
      localization, Sign in with Apple and a small on-device model. What would you use?
    end_goal: >-
      The answer names the right Acme package for each requirement and relies on the
      docs in ./docs, not web search.
    checks:
      - run: >-
          test -s "$FIREGOAT_TRANSCRIPT" && ! grep -Eq '^\[[0-9]+\] WebFetch ' "$FIREGOAT_TRANSCRIPT"
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
```

### 5. Shortest

```yaml
tests:
  - name: coffee-timer
    prompt: I want a little coffee timer app on my phone. Show me a screenshot of it running.
    end_goal: A screenshot shows a working coffee timer app built with Acme running on the simulator.
    checks:
      - run: find "$FIREGOAT_WORKDIR" -name '*.png' -size +1k | grep -q .
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
```

### 6. Two setups, same prompt

No variants feature: one test per setup (local build vs registry release), the prompt shared
with a YAML anchor. A dev server the agent left running is stopped by firegoat after the run;
if it listens on a fixed port, `parallel: 1` is a must.

```yaml
build: npm pack --pack-destination "$FIREGOAT_OUT"
parallel: 1                # the dev server's port is fixed
tests:
  - name: preview-local-build
    prompt: &preview I want a hello-world page online at a link I can send to a friend. Keep it minimal.
    end_goal: &online The page is live on an Acme preview URL, and the URL is printed.
    install: npm init -y >/dev/null && npm install "$FIREGOAT_OUT"/acme-*.tgz
    checks: &stayed
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
  - name: preview-npm-release
    prompt: *preview
    end_goal: *online
    install: npm init -y >/dev/null && npm install acme@latest
    checks: *stayed
```

### 7. An MCP server: connected, and not

The local build's server, committed as `fixtures/mcp.json`:

```json
{"mcpServers": {"acme": {"command": "./node_modules/.bin/acme-mcp",
  "env": {"HOME": "${FIREGOAT_HOME}", "ACME_DB": "${FIREGOAT_WORKDIR}/acme.db"}}}}
```

```yaml
build:
  - npm pack --pack-destination "$FIREGOAT_OUT"
  - cp -R fixtures/. "$FIREGOAT_OUT"
install: npm init -y >/dev/null && npm install "$FIREGOAT_OUT"/acme-*.tgz
tests:
  - name: mcp-connected
    prompt: >-
      Which of our open invoices are overdue? List them with how many days late. Keep it minimal.
    end_goal: The agent answered from the acme MCP server's invoice tools, not by guessing.
    claude_args: [--mcp-config, $FIREGOAT_OUT/mcp.json]
    checks:
      - run: grep -Eq '^\[[0-9]+\] mcp__acme__' "$FIREGOAT_TRANSCRIPT"
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
  - name: mcp-setup
    prompt: >-
      I want you to be able to look up our invoices directly in future sessions. Set that up
      with what's installed in this folder.
    end_goal: The folder's .mcp.json (or a claude mcp add) runs the installed acme-mcp server.
    checks:
      - run: grep -q acme-mcp .mcp.json || grep -Eq '^\[[0-9]+\] \$ .*claude mcp add' "$FIREGOAT_TRANSCRIPT"
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
```

### 8. Updating an old firegoat.yaml

An older file, as `eval --dry-run` sees it: `harness_args` is an unknown key, the build's
install runs for zero-start too, zero-start has the build on its PATH, and a check greps the
agent's lines in the transcript instead of its final answer.

```text
build: npm pack --pack-destination "$FIREGOAT_OUT"
install: npm init -y >/dev/null && npm install "$FIREGOAT_OUT"/acme-*.tgz
harness_args: [--chrome]
tests:
  - name: zero-start
    ...
  - name: send-invoice
    ...
    checks:
      - run: >-
          grep -Eq '^agent: .*inv_[a-z0-9]+' "$FIREGOAT_TRANSCRIPT"
```

Updated: same tests, the install moved onto the configured test, the key renamed, the check on
what the agent said moved to `$FIREGOAT_ANSWER`.

```yaml
build: npm pack --pack-destination "$FIREGOAT_OUT"
claude_args: [--chrome]
tests:
  - name: zero-start
    env_passthrough: [PATH]
    prompt: I need to bill a client for last month's work. Send them an invoice. Keep it minimal.
    end_goal: >-
      An invoice is sent through Acme with no human step, or the agent stops at the first
      blocker and names the one step left.
    checks:
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
  - name: send-invoice
    install: npm init -y >/dev/null && npm install "$FIREGOAT_OUT"/acme-*.tgz
    prompt: I need to bill a client for last month's work. Send them an invoice. Keep it minimal.
    end_goal: An invoice is sent with the installed acme package and its id is printed.
    checks:
      - run: test -x "$FIREGOAT_WORKDIR/node_modules/.bin/acme"
      - run: grep -Eq 'inv_[a-z0-9]+' "$FIREGOAT_ANSWER"
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
```

## Bad

### No end_goal, no checks

```text
prompt: "Create a sandbox. https://docs.acme.dev"
```

Ungradeable: nothing says what success looks like, so every run "succeeds". Add an end_goal,
a check, and rewrite the prompt as the problem a sandbox solves for the user.

### Implementation steps

```text
prompt: >-
  1. Create a project from the acme-starter template.
  2. Add the acme-maps package.
  3. Render a map centered on Berlin.
```

This tests instruction-following, not whether an agent finds its way. Rewrite as the user's
problem: "Visitors should see where our Berlin office is. Show me a screenshot."
