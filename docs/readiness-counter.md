# A readiness figure that cannot flatter — portable instruction

Hand this to an agent starting a new project. It describes what to build, not
how to copy this repository's file.

Asked for by the owner on 2026-09-07: readiness as a percentage in every report,
with a bar beside it.

## The requirement

Every report ends with one line:

```
████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ readiness 31% — 6 of 19 checks green, 0 red,
13 unestablished — 11 wait on a paid run, 2 on work not yet done
```

One command produces it. It reads files on disk and exits in milliseconds.

## The three rules, and why each exists

**1. The percentage comes from countable checks in artifacts, never from
judgement.** A percentage the agent estimated is a percentage the agent
invented. Every check must trace to a file: a requirements list scored against a
report of tests that ACTUALLY RAN AND PASSED, results recorded machine-readably,
the last recorded build result. A claim of coverage is not coverage — the test
report is what checks the claim.

**2. Three states, not two, and the bar draws three characters.**

```
█  green         established and passing
▒  unestablished nobody has asked
░  red           established and failing
```

A filled-and-empty bar must draw unestablished as empty, and empty reads as
"not done yet" when the truth is "not asked yet".

The percentage lies in both directions and both flatter whoever is reporting:

| Wrong reading | What it does |
|---|---|
| unestablished counted as failure | a project that has simply not been asked looks broken |
| unestablished dropped from the denominator | a project that cannot answer at all looks finished |

**3. The qualification travels with the figure, not in a breakdown underneath
it.** The line says how much of the unestablished waits on **money** and how
much waits on **work** — split by reading a recorded field, never by the agent
deciding which is which. Otherwise the one place the number is read is the one
place that does not admit what it is missing.

## Two details that are decisions, not accidents

* **Round down.** 99% must not appear while two checks are open, because the
  figure is read by someone deciding whether the thing is finished.
* **The bar's rounding remainder goes to whatever is genuinely open, never to
  green.** A bar padded with green reports work nobody did.

## What makes the number stay true

Not running the counter often — it reads files and is instant. What keeps it
true is that **results are recorded machine-readably at the moment they are
produced**. Prose written for a human is not something a machine may count: a
run record whose outcome is a sentence leaves every one of its results
unestablished, correctly and uselessly. So the scorer writes its own verdicts
into the run record when it scores, next to what the run cost.

## Tests that must exist

Each of these corresponds to a way the figure lies:

| Test | Guards |
|---|---|
| unestablished is not counted as green | the flattering denominator |
| rounds down | 99% on unfinished work |
| the line names money and work separately | a qualification that overstates what money buys |
| a coverage claim whose named test did not pass is RED | claims accepted as evidence |
| no test report at all is UNESTABLISHED, not red | "I could not look" becoming "it failed" |
| a record with no machine-readable scores is SKIPPED | prose counted as a result |
| an empty scores object is not "answered nothing" | absence read as an empty result |
| an unreadable record does not hide an older good one | one bad file blinding the count |
| the bar is exactly the width asked for, in every mix | a bar that silently misdraws |
| the bar never pads with green | reporting work nobody did |

And a mutation for each: reintroduce the defect, require the named test to fail.
A test with no mutation behind it is a test nobody has checked.
