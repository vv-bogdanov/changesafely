# Contributing

SafeChange accepts focused fixes that preserve its test-first, fail-closed workflow.
For design changes, open a feature proposal before implementing a broad refactor.

## Development setup

```sh
npm ci --ignore-scripts
npm run check
npm run typecheck
npm test
```

The generated App Server protocol is pinned to the Codex version recorded in
`src/app-server/generated/protocol-version.json`. Use `npm run protocol:generate`
only for an intentional protocol upgrade and commit the generated diff separately.

Branch protection is intentionally deferred during rapid MVP development. Before a
public prerelease, maintainers must apply the rules and release gates in
[`docs/PRERELEASE_CHECKLIST.md`](docs/PRERELEASE_CHECKLIST.md).

## Pull requests

- Keep changes minimal and explain user-visible behavior.
- Add regression coverage for defects when possible.
- Do not weaken protected tests, assertions, or fixtures.
- Do not include credentials, `.env` contents, private artifacts, or production data.
- Run `npm run ci` before requesting review.
- Use a separate commit for generated protocol changes.

By participating, you agree to follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
