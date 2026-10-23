---
name: firegoat-onboarding
description: >-
  Draft 2-3 firegoat evals (firegoat.yaml) for the current repo: tests a coding agent
  runs locally with `npx -y firegoat@latest eval`, each with a prompt, an end_goal and script checks.
  Use when the user says "write firegoat evals", "draft evals", "set up firegoat",
  "firegoat init", or asks for local agent-experience (AX) evals of their SDK, CLI,
  API or docs.
---

# Draft firegoat evals

`npx -y firegoat@latest eval` runs the user's own Claude Code, with none of their config and none of their shell's env, in a fresh empty
folder outside the repo (`~/.firegoat/runs/<project-hash>/<random>/work`, named after nothing in the repo) with its own HOME and one prompt, then runs your checks there. Your job: write 2-3 tests
into `firegoat.yaml` that tell the maintainer whether an agent can succeed with their
product the way a new user would.

## 1. Learn the product from the repo (read, don't run)

`README*`, the docs dir (`docs/`, `*.mdx`; quickstarts first), landing copy, package manifests
(`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) for install names and entry points,
`examples/`, and an existing `firegoat.yaml` (keep its tests, see "Updating existing evals" in step 4). Know: the public docs
URL, the credentials it needs (env var names only), and whether the tool needs a fixed port or
starts servers or daemons (step 4).

**Before writing any prompt, write down** (in your notes to the user, not in the yaml):
- **Who the users are** and **what problem the product solves for them**, in their words, from
  the README, landing copy and docs. Not the feature list: "my signup emails land in spam", not
  "transactional email API".
- **The situations** in which such a user reaches for it: what they were doing, what broke or
  was missing. Each test prompt starts from one of these. Only pick problems the docs show the
  product actually solves, so the end goal is reachable.

## 2. Write each prompt as the user's problem

A test asks: can an agent that only knows the user's problem find the product and use it well?
So write the prompt the way a real person types to their coding agent:

- **The problem or goal in their own words.** Vague and underspecified is fine and expected.
  "New users who sign up should get a welcome email", not "use Acme's SDK to send a welcome
  email via POST /emails".
- **No product name, no API, command or package names, no docs URL, no steps.** Those are the
  answer; the test is whether the agent gets there. Exception: if a real user would only ever
  arrive already knowing the product (a migration between its versions, a plugin for it), at
  most one test may name it.
- **The test mix: one zero-start test, then one or two configured tests.**
  - **Zero-start** (exactly one): how a user and their agent meet the product with no context at
    all. Nothing installed by `install:`, no keys, no docs copied in, no config, no product name
    in the prompt: just the user's problem. The agent gets none of the user's shell env (their
    `ACME_API_KEY` doesn't reach it) and its own HOME hides their config files
    (`~/.config/acme`). The build under test must not reach it: top-level `install:` runs for
    every test, zero-start included, so put the build's install on the configured tests' own
    `install:`, and give zero-start `env_passthrough: [PATH]`, so `$FIREGOAT_OUT` isn't on its
    PATH and the build can't be run by bare name. That PATH is still the user's: if the product
    is installed globally on this machine, the agent will find it, so say so in your report (or
    have the user uninstall it first). It measures what the
    [AX tier list](https://firegoat.ai/axlist) measures: does the agent find the product, can it
    get started without a human (anonymous or claimable access, signing up on its own), and when
    it needs a key, do the errors and docs tell it exactly what to do? end_goal: the problem is
    solved hands-off, or the agent stops at the first real blocker and tells the user the one
    step left (which key, where to get it). In your report, give the run its AX tier list
    placement (S hands-off, A just confirm, B copy a key, C figure it out, D blocked), labeled
    "AX tier list placement" in its own line under the zero-start grade, never as "tier" next
    to the checks tier eval prints: they are different scales.
  - **Configured** (one or two): the setup a user has after signing up. A key the user exports
    in their shell goes in `env_passthrough: [ACME_API_KEY]`; one from elsewhere goes in `env:`
    as `ACME_API_KEY: "{{vars.ACME_KEY}}"`, set with `--var ACME_KEY=...`. Or a login the tool
    keeps in a file, copied in by `install:` (see "Logins and where the agent can write"). Use
    a staging account or a local mock of the API started in `build:`/`install:`,
    since the tests run locally. The build under test is installed by the test's own `install:`.
    The prompt is still the user's problem; this measures the product's real use, past the
    first contact.
- **The context does the pointing**, as in a real project: the package already installed by
  `install:`, docs copied into the folder, keys in the env. Say "API keys are in the env" (or "you're logged in to the CLI"),
  without naming the vars (that names the product). Give only what a real user's project would
  already have: don't pre-connect, pre-configure or pre-seed what that user would still have to
  set up (an MCP server, a config file, existing data). That setup is part of the test.
- **Seed through the product's public interface**: when a test needs existing state (notes, a
  project, a pinned comment), create it in `install:` with the product's own CLI, API or MCP,
  the way a user would, never by importing its source or writing its database. Seeding through
  internals breaks on every schema change and costs rounds of debugging.
- **Data in a real account piles up.** When `install:` or a check writes to a shared account
  (a staging workspace, a real inbox), every run adds more and later runs see it. Tag what you
  create with `{{run.id}}` and delete it in `cleanup:`. A seed that outlives the run (in
  `build:`, or with no `cleanup:`) must check that it exists before creating it.
- **One outcome per test**, so a failure points at one thing.
- **Proof, asked for the way a user would**: "show me it works", "send one to me at
  test@example.com", "save a screenshot", so the checks have something to verify.
- **"Keep it minimal."** so the agent doesn't build a demo app.
- **Local build under test**: with `build:` / `install:` (step 4), add "What's installed in
  this folder is the build under test; don't reinstall or upgrade it from the registry."
- **No sandbox**: the folder is outside the repo and its path names nothing in it, but the
  agent runs as the user: agents have scanned `~` and read the parent's process list. Every
  test gets a check that it stayed in its folder (see step 3).
- **Expected answers the agent must not see** (a seeded password, a generated id): write them to
  `$FIREGOAT_RUN_DIR` in `install:` and read them there in checks. The agent never gets that path.

## 3. Write the end_goal and checks

`end_goal`: what is true when the user's problem is solved, checkable from the transcript and
workdir. The prompt is vague; the end_goal is concrete and may name the product: "A signup
sends a welcome email through Acme's SDK, not raw HTTP, and the script prints the message id". firegoat never
grades it, only hands it over; you judge it after the run (step 5). It and each check state one
outcome that happened or didn't: no "or equivalent", no partial credit, nothing that passes
because the agent stopped at a blocker.

`checks`: shell commands run in the agent's workdir after the run; exit 0 = pass. Env:
`FIREGOAT_WORKDIR` (the workdir), `FIREGOAT_TRANSCRIPT` (what the agent did, plain text, greppable
line by line: every line of a shell call starts with `[n] $ ` (same n for the whole call, so a
multi-line command or heredoc matches on any line); a tool with a path, url, pattern or query is
`[n] Write <path>` etc. (not the file body: check the file); any other tool, MCP ones included,
is one line `[n] mcp__<server>__<tool> <json input>` cut at 4000 chars; tool output is indented
4 spaces (15 lines or 1500 chars), every line of the agent's text and final answer starts with
`agent: `, then the files it made), `FIREGOAT_ANSWER` (`answer.txt`: the agent's final answer
alone, uncut; empty when it gave none), `FIREGOAT_SESSION` (claude's full session file, JSON,
~50x larger, escaped; don't grep it), `FIREGOAT_OUT` (build's outputs, shared by all runs of one eval),
`FIREGOAT_HOME` (the run's own HOME), `FIREGOAT_RUN_DIR` (the run's folder in the repo,
hidden from the agent), `FIREGOAT_REPO` (the folder holding firegoat.yaml), any `vars` and the
run's `env:`. `install:` and `cleanup:`
get the same, minus the transcript, answer and session (`cleanup:` gets those when the agent ran).
Prove the outcome and catch cheating:
- The real thing was used: `grep -Eq '^\[[0-9]+\] \$ (.*[ /])?acme +send' "$FIREGOAT_TRANSCRIPT"`.
  Match the subcommand that does the job, and allow a path before the binary: agents also call it
  as `$FIREGOAT_OUT/acme`, `./node_modules/.bin/acme` or through `npx`.
- The local build was used, not a registry install (see step 4 for the full guard):
  `test -s "$FIREGOAT_TRANSCRIPT" && ! grep -Eq '^\[[0-9]+\] \$ .*(pip install|npm (install|i) .*acme@)' "$FIREGOAT_TRANSCRIPT"`.
- Only local docs were used (when that's the point): `test -s "$FIREGOAT_TRANSCRIPT" && ! grep -Eq '^\[[0-9]+\] WebFetch ' "$FIREGOAT_TRANSCRIPT"`.
- It stayed in its folder, on every test: the repo's path (`$FIREGOAT_REPO`, the folder holding
  firegoat.yaml; checks get it, the agent doesn't) appears nowhere in the transcript, neither in
  a command nor in output it read (a `ps` or a search of `~`). This also keeps it out of the
  repo's `fixtures/`:
  ```yaml
  - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
  ```
- What the agent told the user: grep its final answer, `$FIREGOAT_ANSWER`, so a word that shows
  up only in a command's output or the agent's earlier messages doesn't match:
  ```yaml
  - run: grep -qi 'acme_api_key' "$FIREGOAT_ANSWER"
  ```
  A grep can't tell "use acme" from "don't use acme": what the answer means is the end_goal,
  judged by a person.

Anchor greps to the transcript's tool-call lines, `^\[[0-9]+\] \$ ` (commands) or
`^\[[0-9]+\] Write ` etc., not plain words: tool output (a README showing `$ npm install acme`)
and the agent's prose ("I won't pip install") must not trip a check. To check what the agent
said along the way, anchor to `^agent: `. Commands appear unescaped, exactly as run, and every line of a
multi-line command carries the prefix, so one grep covers scripts and heredocs too. Start every negated grep with `test -s "$FIREGOAT_TRANSCRIPT" &&`:
on a missing file grep exits 2 and `!` turns that into a pass. A check containing `: ` (like
`'^agent: '`) must be a `run: >-` block (or quoted), else firegoat.yaml is invalid YAML.

## 4. Write firegoat.yaml

```yaml
runs: 1                    # runs per test
build: npm pack --pack-destination "$FIREGOAT_OUT"   # optional: once per eval, in the repo;
                           # $FIREGOAT_OUT is first on the agent's PATH (unless
                           # env_passthrough lists PATH)
install: git config --global user.email eval@example.com
                           # optional: in each fresh workdir before the agent starts,
                           # for every test (zero-start too), before the test's own
cleanup: ./delete-seeded-data.sh
                           # optional: after the checks, always; never changes the verdict
vars:                      # optional: defaults for {{vars.KEY}}; `--var KEY=value` overrides
  SHA: main                # build, install, checks and cleanup only, never the agent
env:                       # optional: the agent's env (also its install, checks, cleanup)
  ACME_TELEMETRY: "off"
env_passthrough: [HTTPS_PROXY]   # optional: host vars the agent gets, by name
claude_args: []            # optional: extra claude arguments, one entry each
tests:
  - name: quickstart       # letters, digits, '.', '_', '-'; unique
    prompt: >-
      ...
    end_goal: ...          # judged by you after the run, not by firegoat
    checks:                # optional
      - run: grep -rq some-marker "$FIREGOAT_WORKDIR"
      - run: test -s "$FIREGOAT_TRANSCRIPT" && ! grep -qF "$FIREGOAT_REPO" "$FIREGOAT_TRANSCRIPT"
    timeout: 600           # optional, seconds
    env:                   # optional: on top of the top-level env:
      ACME_BETA_LOGIN: "1"
    env_passthrough: [ACME_API_KEY]   # optional: after the top-level ones
    install: npm init -y >/dev/null && npm install "$FIREGOAT_OUT"/*.tgz
                           # optional: after the top-level install; the build under test
                           # goes here, on the configured tests only
    cleanup: acme down || true                  # optional: before the top-level cleanup
    claude_args: [--chrome]                     # optional: e.g. a test that needs a browser
```

The agent gets none of the shell's env beyond a fixed base (PATH, HOME, USER, locale, claude's
login vars). `env_passthrough:` hands it host vars by name: a proxy, a CA file, a token the user
exports. A name the shell doesn't set is a config error. `env:` sets values; the agent never
sees `vars:`. Use `env:` for feature flags and pointing a tool at the local build. Values are strings (quote numbers) with
placeholders `{{vars.KEY}}`, `{{run.id}}`, `{{run.n}}`, `{{test.name}}`, plus `$FIREGOAT_OUT`,
`$FIREGOAT_WORKDIR` and `$FIREGOAT_HOME` (no other `$` expansion, `$HOME` stays literal).
`PATH`, `CLAUDE_CONFIG_DIR`, `FIREGOAT_*`, `ANTHROPIC_MODEL` (use `model:`), `HOME`, the XDG
`*_HOME` vars and `CLAUDE_ENV_FILE` are firegoat's and can't be set. Credentials stay in the
shell that runs eval, not in firegoat.yaml.

Every run gets its own HOME (`$FIREGOAT_HOME`, with XDG dirs; claude keeps the real login), so
parallel runs don't collide and a tool's state in `~` starts fresh. Only a tool that ignores
HOME needs `ACME_HOME: "$FIREGOAT_HOME/.acme"`. A product that serves on a fixed port must
have `parallel: 1` in firegoat.yaml, and only one eval may run at a time: two runs on one port
collide. Logins in
`~` or the keychain look logged out in a run ("Logins and where the agent can write", below). Stop servers or daemons the agent
may leave running with `cleanup:`, not a check.

**Fixtures** (helper scripts, sample data, a fake server the test needs, an MCP config) go in
files under `fixtures/` next to firegoat.yaml, committed, never inline as heredocs. Copy them once with `build: cp -R fixtures/. "$FIREGOAT_OUT"`, then copy what a
test needs into its folder with that test's own `install:` (`cp "$FIREGOAT_OUT/wizard.mjs" .`).
Files in `$FIREGOAT_OUT` are also on the agent's PATH.

**Comparing setups** (local build vs registry release, with vs without `--chrome`): write one
test per setup with the same prompt (a YAML anchor, `prompt: &p ...` then `prompt: *p`) and a
different per-test `install:`, `env:` or `claude_args:`. Skills installed into the run folder
are not loaded under eval's flags, so a with/without-skill comparison doesn't work.

`build:` and `install:` take one shell command or a list. Python:
`build: uv build --wheel --out-dir "$FIREGOAT_OUT"` and
`install: uv venv && uv pip install "$FIREGOAT_OUT"/*.whl`. A binary written to
`$FIREGOAT_OUT` is on the agent's PATH, but that only helps for CLIs called by bare name.
- **npx**: pack and install the CLI into the workdir (the npm example above); `npx acme` prefers
  `node_modules/.bin`. Add a positive check `test -x "$FIREGOAT_WORKDIR/node_modules/.bin/acme"`.
- **uvx**: it uses its own tool environment and ignores the workdir `.venv` and a project
  `uv.toml`, so point it at the wheel with `env: {UV_FIND_LINKS: "$FIREGOAT_OUT"}`.
  uv takes the highest version from the index and the links, so the
  local build must be newer than the release.
- **pipx run**: test the bare-name binary or `python -m acme` from the workdir `.venv` instead,
  and say so in the prompt.

Guard against the registry release in either case:
`test -s "$FIREGOAT_TRANSCRIPT" && ! grep -Eq '^\[[0-9]+\] \$ .*((npm (install|i|add)|pnpm (add|dlx)) .*acme|(npx|bunx|yarn dlx) .*acme@|uvx .*acme(@|==)|pipx (run|install) .*acme|pip3? install .*acme)' "$FIREGOAT_TRANSCRIPT"`
Don't flag plain `npx acme` or `uvx acme`: with the local build that's the right way to run it
(but `npx acme@latest` skips it, hence `acme@` in the guard), and the positive
`node_modules/.bin` check above proves the local build is there.
Add them only when the tests should use the repo's local build.

If `firegoat.yaml` exists, merge: keep every existing test and top-level key, append yours, and
suffix yours with `-2` on a name collision. Never delete or rewrite user tests, except the
starter `goat` smoke test from `init`: run it first to confirm the setup works, then replace it. Use `>-` folded
blocks for prompts so colons and quotes stay valid YAML.

### Updating existing evals

When `firegoat.yaml` already exists (written for an older firegoat), bring it up to these rules
before adding anything:

- **Run `npx -y firegoat@latest eval --dry-run` first.** Old keys are now errors (no aliases):
  the error names the key and lists the allowed ones. `harness_args:` became `claude_args:`
  (or `codex_args:` / `grok_args:`, one per harness).
- **The zero-start test gets `env_passthrough: [PATH]`**, even if it worked before without it.
- **The build's install goes on the configured tests' own `install:`**, never top-level
  `install:`, which runs for zero-start too.
- **Every test checks that it stayed in its folder** (the `$FIREGOAT_REPO` check in step 3).
- **Checks on what the agent said move to `"$FIREGOAT_ANSWER"`** (firegoat 0.34+):
  `grep '^agent:' "$FIREGOAT_TRANSCRIPT"` and similar become a grep of `"$FIREGOAT_ANSWER"`,
  the final answer alone.
- **Keep the tests that still make sense**; only fix their shape. Say in your report what you
  changed and why.

Before finishing, re-read the file: it parses as YAML, every test has a non-empty `name`,
`prompt` and `end_goal`, names are unique and match `^[A-Za-z0-9._-]+$`, no credential values
appear anywhere, the zero-start test gets no build installed and `env_passthrough: [PATH]`,
every test checks that it stayed in its folder, and every test that writes to a
real account uses a test workspace, pinned in `install:` or `env:`, with a check on where its
writes landed.

### Logins and where the agent can write

Every run has its own HOME, so a tool whose login is a file (`~/.config/acme/auth.json`) or the
keychain (`gh`, `docker`) looks logged out in a run. Prefer a token scoped to a test workspace,
named in `env_passthrough:` (or set with `env:` and `{{vars.X}}`). When the tool only has a browser login, copy the
file in from `install:` and delete it in `cleanup:`; the path comes from the shell with `--var`:

```yaml
# npx -y firegoat@latest eval --var ACME_LOGIN="$HOME/.config/acme/auth.json"
install:
  - install -d -m 700 "$XDG_CONFIG_HOME/acme" && install -m 600 "{{vars.ACME_LOGIN}}" "$XDG_CONFIG_HOME/acme/auth.json"
  - acme whoami | grep -q "workspace acme-test" || { echo "Refusing, the acme login is not on the acme-test workspace" >&2; exit 1; }
cleanup: rm -f "$XDG_CONFIG_HOME/acme/auth.json"
```

Never copy keychain items into a run (that reads a secret out of the user's keychain): pass a
token, or log a test account in from `install:`. If the tool rotates its refresh token, a run
can log the user's real login out: copy only the access token if the tool allows it, or use a
separate test account.

**A login reaches everything its user can see.** There is no sandbox. The agent picks the
workspace, project or org it finds first, and with the user's own login that can be production.
One real run registered a test repo in a production workspace, and removing it was manual.
Before the first eval:

- **Use a dedicated test workspace** (or org, project, account) that holds nothing real. Ask
  the human for one if it doesn't exist; don't create it yourself.
- **Prefer a token scoped to that workspace** over the user's personal login, which can write
  wherever its user can.
- **Pin the workspace in setup**: in `env:` (`ACME_WORKSPACE: acme-test`) or from `install:`
  (`acme workspace use acme-test`), and fail `install:` when `whoami` shows anything else. The
  prompt doesn't name it: the agent should find it the way it would in a user's project.
- **Check where writes landed**: a check asks the product what the run created (tagged with
  `{{run.id}}`), finds it in the test workspace and nowhere else the login can see, and
  `cleanup:` deletes it.
- If none of that is possible (only a personal login, no test workspace), tell the human which
  workspaces the login can write to and wait for a go-ahead before running eval.

### Testing an MCP server

Do this when the product ships an MCP server: a package `bin` or an `mcp` subcommand that
starts one, a README or docs page about MCP, or a `@modelcontextprotocol/sdk` (or `mcp`,
`fastmcp`) dependency.

- **Install the local build** in `install:` as usual (the npm example above), so the server
  under test is `./node_modules/.bin/acme-mcp` in the run folder (or `.venv/bin/acme-mcp`).
- **Commit `fixtures/mcp.json`**, a static config pointing at that local server. claude expands
  `${VAR}` in it from its own env, which holds the run's `FIREGOAT_HOME`, `FIREGOAT_WORKDIR`
  and `FIREGOAT_OUT`; relative paths are from the run folder. MCP servers inherit claude's real
  HOME (its login), so always set the server's `HOME` to `${FIREGOAT_HOME}`, or it writes to the
  user's. Give anything else the server keeps per run (a database file, a port) a per-run value
  the same way. Use `${...}` with braces; an unset var stays literal text.
  ```json
  {"mcpServers": {"acme": {"command": "./node_modules/.bin/acme-mcp", "args": ["serve"],
    "env": {"HOME": "${FIREGOAT_HOME}", "ACME_DB": "${FIREGOAT_WORKDIR}/acme.db"}}}}
  ```
- **Pass it per test**: `build:` copies the fixtures (`cp -R fixtures/. "$FIREGOAT_OUT"`), and a
  test that starts with the server connected gets
  `claude_args: [--mcp-config, $FIREGOAT_OUT/mcp.json]`. Only configs passed this way load
  (`--strict-mcp-config` is always on), so a test without it starts with no MCP server.
- **Prompts stay problem-first.** With the server connected, the prompt is the user's problem
  and never names the tools: the question is whether the agent picks them up. Also write **at
  least one test where it isn't connected**: the agent has to find the MCP server and set it up
  itself (e.g. write `.mcp.json` in its folder or run `claude mcp add`). A server it adds mid-run
  may only load in a new session, so that test's end_goal and checks grade the setup
  (`test -s "$FIREGOAT_WORKDIR/.mcp.json"`, a `claude mcp add` command in the transcript), not
  tool use.
- **Check tool use** in the transcript: an MCP call is a line `[n] mcp__<server>__<tool> {...}`,
  where `<server>` is the key under `mcpServers`:
  `grep -Eq '^\[[0-9]+\] mcp__acme__search' "$FIREGOAT_TRANSCRIPT"`.
- **Servers stop on their own**: after `cleanup:`, firegoat stops whatever the agent or `install:`
  left running in the run (its process group, or anything with its cwd in the workdir) and lists
  it in run.json `leftover`. `cleanup:` is for things outside the run: seeded data in a real
  account, a container started with `docker run -d`.

## 5. Run and grade

firegoat runs the user's `claude` on its existing login. If eval says claude is not logged in,
ask the human to run `claude` once and log in; don't wait silently.
`npx -y firegoat@latest eval --dry-run` validates firegoat.yaml and lists
the runs without starting any: run it first, no need to ask.

**Ask before the first real eval.** Tell the user it runs real agent sessions on their Claude
subscription (it costs usage), and, when they're logged in to firegoat.ai, uploads every session
as a private trace unless they pass `--no-upload`. Then run plain `npx -y firegoat@latest eval`
yourself: no `--json`, output not redirected to a file. A run takes minutes. Run eval without
`--no-upload` unless the user asks for it: the uploaded traces are what the user looks at, and
eval prints their URLs. Put the trace URLs in your report; don't `open` them in the user's
browser unless they ask.

**Show the results block first.** eval's last output is the results block (each run's status,
checks, turns, tokens, time and trace URL, the totals and the checks tier: the share of runs whose
checks passed, never the end_goal), between two lines of `═`. Show what's between them to the
user verbatim in a fenced code block, before your own grades and analysis. Not the stderr log or
the PASS/FAIL lines, not your own table. Never paraphrase, redraw or trim it. If you used `--json`
anyway, it doesn't print the block: `cat .firegoat/runs/<runId>/results.txt` (`runId` is in the
summary) and show that.

firegoat runs only the script checks; they set the exit code (0 pass, 1 a check failed, 2 not
graded, 3 config error). Read the verdict from the exit code and each run's `status`, not from
the tail of the output. **You judge the end_goal.** For each run, read
`.firegoat/runs/<runId>/<test>/<n>/run.json` (prompt, end_goal, check results, paths), then:
- `transcript` (a few KB): every command the agent ran with its short output, what it said, its
  final answer and the files it made. Did it reach the end goal with the product, or fake it,
  give up, or ask for help? Open `session` (claude's full JSON) only if a step's output was cut
  and you need it.
- `workdir`: the files it made. Run them if that's how the end goal is proven. Each criterion in it: met or not, with the evidence.

firegoat records no verdict beyond the checks: keep your grades yourself (per run: end_goal
met or not, and the evidence). Don't put a second grade or tier of your own next to the checks
tier; the zero-start AX tier list placement (step 2) is labeled as such, on its own line. A run can pass its checks and still fail the end goal (e.g. it hard-coded the
output, or solved the problem with a competitor); say so.

**Aim for evals that fail.** A suite that passes on the first try measures nothing: the point is
to find where agents get stuck. Target 20 to 50% of the runs failing. If more than 80%
pass, first rerun the same tests on smaller models (`npx -y firegoat@latest eval --model sonnet
--model haiku`): weaker agents show where the product's docs and errors don't carry them. If
those pass too, make the passing tests harder and run eval again, at most twice:
- Remove pointing: the product name or its vars in the prompt, a pre-connected server, pre-seeded
  data, docs copied in when a real user wouldn't have them.
- Make the ask vaguer and closer to how the user would phrase the problem.
- Ask for a real outcome with proof (it actually ran, sent or saved something), not a code sketch.
- Add a realistic constraint from the user's situation (an existing project, a framework they
  already use, a second step that depends on the first).
Keep each end goal reachable with the product as documented: a test that fails because the
task is impossible tells the user nothing. Report which tests you hardened and why.
Once a run fails for a real product reason, stop polishing that test: the failure is the result.

## 6. Hand off and commit

Start with the results block from step 5, verbatim in a code block. Then tell the user in a few
lines: which tests you added and why, which env vars to export (the `env_passthrough:` names)
and `--var`s to pass, the checks and your grades per run, and where the agent got stuck (quote the transcript).
When you compare runs, use tokens, turns and time, never dollars or `cost`: the user runs on
their own subscription, so a dollar figure misleads.

Onboarding is finished when the evals are committed, so the team and CI run the same tests.
End by asking the user to commit, and offer to do it: "Commit firegoat.yaml to finish
onboarding?" On yes, commit with a message like `chore: add firegoat evals`:
- `firegoat.yaml`, and `fixtures/` if you made fixtures (`.firegoat/` ignores itself in git);
- only if the skill was installed into the repo (`init --local-skills`, or picked "this repo";
  the default is global, in `~/.claude/skills/`, and there is nothing to commit):
  `.claude/skills/firegoat-onboarding/` and `skills-lock.json`.

If `.gitignore` ignores `.claude/`, say so and ask before `git add -f`.
Never commit anything in `.firegoat/` (runs, sessions) or credentials.

## Examples

`references/examples.md` has good and bad tests with their YAML.
