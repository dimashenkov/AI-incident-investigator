# Choosing the Codex model, on this machine

Hand this to an agent that runs Codex reviews in any project here. Everything in
it was measured on 2026-09-06, not assumed.

## The short version

```bash
codex exec -s read-only --skip-git-repo-check -m gpt-5.6-terra "PROMPT" < /dev/null 2>&1
```

`-m` works on the ChatGPT subscription. No API key, no API billing.

## Which model

| Model | Use it for |
|---|---|
| `gpt-5.6-terra` | **the default** for reviews — the balance of capability and usage |
| `gpt-5.6-sol` | the hard one: architecture, concurrency, security, a large diff |
| `gpt-5.6-luna` | a fast, shallow check |
| `gpt-5.5`, `gpt-5.4-mini` | available; no reason to prefer them for a new workflow |

## Do not guess the name — read the list

The allowed names are per account and live on disk:

```bash
python3 -c "import json,io,os;d=json.load(io.open(os.path.expanduser('~/.codex/models_cache.json')));print(sorted(m.get('id') or m.get('slug') for m in d['models']))"
```

Guessing is how a wrong conclusion gets drawn. On 2026-09-06 four invented names
(`astra`, `gpt-5-codex`, `gpt-5`, `o3`) all failed the same way, and the
conclusion drawn from that — "the subscription forbids choosing a model" — was
wrong. The list had five perfectly usable names in it.

## The two error messages are different, and that difference is the diagnosis

| What the server says | What it means |
|---|---|
| `not supported when using Codex with a ChatGPT account` | that name is not in your list — read the list |
| `requires a newer version of Codex` | the account knows it; the CLI is too old |

`gpt-6-astra` gives the second. It is a separate model, not another name for a
5.6, and it needs Codex **0.153.0+**; this machine has 0.149.0.

## Turning on gpt-6-astra

Three steps, and the first belongs to the owner — an agent does not upgrade
software on somebody's machine.

**1. Upgrade.** Measured 2026-09-06: installed 0.149.0, available 0.153.4.

```bash
brew upgrade --cask codex
```

**2. Check the account has it.** The model list is refetched on the first run of
the new version.

```bash
codex --version
python3 -c "import json,io,os;d=json.load(io.open(os.path.expanduser('~/.codex/models_cache.json')));print(sorted(m.get('id') or m.get('slug') for m in d['models']))"
```

**3. Run it.**

```bash
codex exec -s read-only --skip-git-repo-check -m gpt-6-astra "PROMPT" < /dev/null 2>&1
```

What each answer means:

| Answer | Meaning |
|---|---|
| it answers | done |
| `requires a newer version of Codex` | the CLI is too old; nothing is known about the account yet |
| `not supported when using Codex with a ChatGPT account` | the CLI is new enough and this account does not have the model |

On 2026-09-06 this machine gave the second answer in the table, and that is the
only thing measured. **It does not establish that the account has Astra** — the
server refused on the version and never got as far as the entitlement. After the
upgrade the answer may still be the third line.

Saying "the account has it, only the CLI is old" would be a claim from one error
message that names one cause. The version is simply the first thing in the way,
and it is the only thing that can be changed to find out what is behind it.

None of this needs an API key: the 5.6 models run on the ChatGPT allowance, and
Astra would too.

## What this does not change

Codex runs on the owner's ChatGPT subscription — a flat monthly fee. Choosing a
model does not move that, and none of this needs an API key. The rule that
review is not a purchase still holds.

## The whole invocation, unabridged

```bash
codex exec -s read-only --skip-git-repo-check -m gpt-5.6-terra "PROMPT" < /dev/null 2>&1
```

| Part | Why it is not optional |
|---|---|
| `-s read-only` | it writes nothing; never `--force`, never `--yolo` |
| `--skip-git-repo-check` | it refuses in some trees otherwise |
| `< /dev/null` | without it, a `<` in the prompt makes the shell redirect and the command HANGS rather than failing |
| `2>&1` | part of the verdict arrives on stderr |
| `-m` | otherwise the server picks, and two runs are not comparable |

Run it in the background: a round is minutes, and waiting is stopping.

Keep angle brackets and backticks out of the prompt text for the same reason
`< /dev/null` is there.
