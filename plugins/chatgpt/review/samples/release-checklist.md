# Release checklist (synthetic sample)

> Synthetic sample written for the anymd ChatGPT review account. It describes no real company or product.

Run this list before every production release.

1. All automated tests pass on the release branch.
2. Database migrations are additive and tested on a copy of production data.
3. A rollback plan names the previous version and the command to restore it.
4. Release notes describe user-visible changes in plain language.
5. Support has the notes one day before the release.
6. After release, watch error rates for 30 minutes before announcing.

## Why step 6 matters

Most regressions show up in the first minutes of real traffic. Announcing only after the error rate holds steady avoids sending users to a broken feature.
