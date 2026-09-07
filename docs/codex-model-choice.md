# Choosing the Codex model, on this machine

Hand this to an agent that runs Codex reviews in any project here. Everything in
it was measured on 2026-09-06, not assumed.

## The short version

```bash
codex exec -s read-only --skip-git-repo-check "PROMPT" < /dev/null 2>&1
```

## Which model — none, here

The owner decided on 2026-09-06 not to pass `-m` at all, which is how most of
this project's reviews were already run. The server picks.

The rest of this file is what was measured while trying the other way, and it
stands because the next project may want the choice. `-m` does work on the
ChatGPT subscription, with a name from the account's own list, and it needs no
API key.

The cost of not passing it: two runs are not strictly comparable if the server
moves the model underneath you. That is accepted here deliberately.

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

## gpt-6-astra — dropped

The owner dropped it on 2026-09-06. It is left here only so nobody spends an
afternoon rediscovering the same two facts:

* the identifier is `gpt-6-astra`, not `astra`, and the wrong one gives a
  misleading error about ChatGPT accounts;
* with Codex 0.149.0 the server refuses on the VERSION and never reaches the
  entitlement — so that refusal says nothing about whether an account has it.

Upgrading (`brew upgrade --cask codex`) is what would answer the question. It is
not being done, because the 5.6 models are enough for reviews here.

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
