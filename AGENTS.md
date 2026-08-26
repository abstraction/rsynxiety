# Developer guidelines for agents

## Package management

Always use `pnpm` for everything. Do not use `npm` or `yarn` to install dependencies, run scripts, or manage the project.

## Dependency security and quality

When adding a new external library, you must verify three things.

1. **Adoption.** Look for millions of weekly downloads on npm. Avoid niche libraries with fewer than a thousand weekly downloads unless they solve a hard technical requirement and you vet the code manually.
2. **Reputation.** Check who maintains it. Look for reputable authors like Sindre Sorhus or established organizations. Verify the GitHub repository is active with recent commits.
3. **Security.** Check the exact spelling to catch typo-squatting. Check the dependency tree. A library that pulls in fifty other dependencies introduces unnecessary risk. Prefer zero-dependency libraries where possible.

### Approved stack

We use this stack.

* `commander`
* `@clack/prompts`
* `listr2`
* `execa`
* `picocolors`
* `boxen`
* `pretty-bytes`
