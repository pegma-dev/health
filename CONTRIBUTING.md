# Contributing to Health

Thank you for helping improve Health.

## Before opening an issue

- Search existing issues for related work.
- Use GitHub's private vulnerability reporting flow for security concerns.
- Describe the probe you need and what must stay off the public response, not
  only the API shape you would like.
- If a proposal needs this package to own a store or auto-discover checks, say
  so explicitly — those are the changes the design cannot absorb.

## Local development

Health requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run format:check
```

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the intended component behavior;
- tests for new behavior;
- documentation for public API changes.

Store probes must include a test that a rejected write surfaces as `fail`.
Public detail fields must stay free of secrets.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
