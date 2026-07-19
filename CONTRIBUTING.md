# Contributing

SafeChange accepts focused fixes that preserve its test-first, fail-closed workflow.
Discuss broad architectural changes when coordination is useful; a separate proposal
is not required for a small, evidence-backed decision update.

## Development setup

```sh
npm ci --ignore-scripts
npm run check
npm run typecheck
npm test
```

The generated App Server protocol uses the exact development baseline recorded in
`src/app-server/generated/protocol-version.json`. Use `npm run protocol:generate`
for an intentional baseline upgrade and include the generated diff in that upgrade.

Branch protection is intentionally deferred during rapid MVP development. Before a
public prerelease, maintainers must apply the rules and release gates in
[`docs/PRERELEASE_CHECKLIST.md`](docs/PRERELEASE_CHECKLIST.md).

## Pull requests

- Keep changes minimal and explain user-visible behavior.
- Add regression coverage for defects when possible.
- Do not weaken protected tests, assertions, or fixtures.
- Do not include credentials, `.env` contents, private artifacts, or production data.
- Run relevant local checks while iterating; GitHub CI owns the full matrix. Run
  `npm run ci` at the release boundary.

By participating, you agree to follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
