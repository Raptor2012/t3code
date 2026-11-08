# Fork maintenance (Raptor2012/t3code)

This fork adds built-in local voice (dictation and spoken replies) to T3 Code. It is a short
series of commits on top of upstream's latest stable release, so it keeps getting upstream's
updates.

## Branches and remotes

- `upstream` is `https://github.com/pingdotgg/t3code.git`. `origin` is the fork.
- `voice` is the fork's default branch: upstream's latest stable tag plus the fork's commits.
- `main` mirrors upstream `main` and carries no fork commits.

Fork-only files are kept apart so they never conflict with upstream and are easy to leave out of
an upstream PR: `.github/workflows/fork-release.yml` and this page.

## Rebasing onto a new upstream release

Rebase only onto stable tags (`vX.Y.Z`), never nightlies or previews.

```sh
git fetch upstream --tags
git switch voice
git rebase --onto vX.Y.Z <previous stable tag> voice
```

Then:

1. Resolve conflicts, keeping upstream's behavior and re-applying the fork's change on top.
2. Run `vp run check:changed` and the voice tests and benchmark.
3. `git push --force-with-lease origin voice`.
4. Tag a release: `git tag vX.Y.Z-voice.1 && git push origin vX.Y.Z-voice.1`.

## Versions and releases

Fork versions are `<upstream version>-voice.<n>`, for example `0.1.7-voice.1`. Bump `<n>` for
fork-only releases and reset it to 1 after each rebase.

Pushing a `v*-voice.*` tag runs [fork-release.yml](../../.github/workflows/fork-release.yml).
It builds Windows x64, macOS arm64 and x64, and Linux x64 on GitHub-hosted runners, then
publishes a GitHub release with the updater manifests. Builds use upstream's public T3 Connect
configuration from `.env.example`. Their update feed is this repository
(`T3CODE_DESKTOP_UPDATE_REPOSITORY`), so installs update from the fork's releases, never
upstream's.

To try a change on Windows first, tag a test build, `vX.Y.Z-voice.<n>.<m>`, for example
`v0.1.7-voice.7.1`. It builds and publishes Windows only and sorts before `voice.<n+1>`. It
becomes the latest release, so macOS and Linux installs see no update until the next full release.

Upstream's own workflows are disabled in the fork's Actions settings. They only run in
`pingdotgg/t3code` and on Blacksmith runners.

## Signing

Windows and Linux builds are unsigned. macOS builds are not signed by Apple. Users open the app
the first time from System Settings, Privacy & Security, Open Anyway.
