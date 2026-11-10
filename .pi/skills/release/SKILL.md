---

name: release
description: Prepare and publish a pi-agents-autoload release. Check readiness, review changes, draft release notes for approval, then publish npm and Git tags.
disable-model-invocation: true
---

# Release pi-agents-autoload

Run from the repository root when invoked with `/skill:release`. Stop on failed checks or unresolved problems. Never commit, tag, push, or publish without the user's explicit approval.

## 1. Check readiness

1. Confirm this is the intended repository on the release branch (`main`), with the expected `origin`. Fetch the latest branch and tags; resolve any branch divergence before releasing.
2. Check Git status. If there are uncommitted or untracked changes, **stop**. Inspect them and recent commit subjects, suggest one suitable commit title matching the repository's style, and ask whether to commit. Do not commit without separate permission; resume only with a clean tree.
3. Find the latest release tag (`v<version>`), check commits since that tag, and compare `package.json`, `package-lock.json`, and the npm registry. Stop if there are no meaningful changes or the version history conflicts. Recommend patch/minor/major based on the changes unless specified.
4. Check required release access (npm authentication and Git push; GitHub CLI access if creating a GitHub Release). Report optional issues as warnings rather than blocking unnecessarily.

## 2. Review and present the release

1. Review **all commits and the actual diff** since the last release, including relevant source, tests, and documentation. Base notes on behavior changes, not commit titles alone.
2. Run `npm ci` and `npm run check`. Inspect `npm pack --dry-run --json` for correct package metadata, `pi.extensions` entry point, required `src/` files, README, LICENSE, and unexpected contents. Stop on a failed check or a broken package.
3. Present, in this order:
   - Proposed version and readiness/check results.
   - **Included commits:** short hash and subject for each.
   - **Change summary:** brief bullets ordered by significance (features, fixes, improvements as applicable). Keep this separate from public notes.
   - **Exact draft release notes** for GitHub. If `CHANGELOG.md` already exists, propose the matching new section; otherwise do not create one unless asked.
4. Ask for approval or edits. Revise and present the draft again until approved. If source changes are needed, have them committed and rerun readiness and checks before proceeding. Approval covers publishing and the necessary release-only version/notes commits.

## 3. Publish the approved release

1. Confirm the branch and commit range are still the ones reviewed and the tree is clean. If they changed, return to the review step.
2. If an existing `CHANGELOG.md` is to be updated, write only the approved entry and commit it. Run `npm version <approved-bump>` to update package and lockfile versions and create npm's normal **`v<version>` annotated Git tag**. Verify the version, tag, and clean tree.
3. Run `npm pack --pack-destination <temporary-directory>` and inspect the actual tarball. Confirm `name@version` is not already published. Publish **that same tarball**, not a newly generated one.
4. Push the release commit and `v<version>` tag to `origin` and verify the remote tag points to the expected commit. Complete this **before** `npm publish`, so publishing never succeeds with an unpushed tag.
5. Run `npm publish <tarball> --access public` and verify the version on npm. Create a GitHub Release using the approved notes if agreed during review.
6. Report the published npm version, commit, verified remote tag, and GitHub Release link if created.

If any step fails, stop and report what succeeded and what remains. Never blindly retry an uncertain publish, move a published tag, or repeat the version bump.
