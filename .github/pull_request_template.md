## Summary of Changes

<!-- Include a high-level overview of your implementation, including any alternatives you considered and items you'll address in follow-up PRs -->

-

### Manual testing instructions

<!-- Include any special instructions to help reviewers verify your changes: which tool(s) to invoke, required env vars, transport(s) exercised (stdio/http/sse), and sample inputs/outputs. For quick iteration, `npm run inspector` launches the MCP Inspector. Delete this section if not applicable (e.g., docs-only or CI changes) -->

1.

### Optional: Any additional details or context that should be provided?

<!-- Behavior before/after, screenshots of client output, follow-on work that should be expected, links to discussions or issues, etc -->

-

## Pull request checklist

Please check if your PR fulfills the following (if applicable):

#### Tests

- [ ] Added new
- [ ] Updated existing
- [ ] Deleted existing

#### OpenAPI types

<!-- prettier-ignore -->
- [ ] If this PR introduces calls to a new Confluent Cloud REST endpoint, have you updated `openapi.json` and regenerated `src/confluent/openapi-schema.d.ts`?

#### Release notes

<!-- prettier-ignore -->
- [ ] Does anything in this PR need to be mentioned in the user-facing [CHANGELOG](https://github.com/confluentinc/mcp-confluent/blob/main/CHANGELOG.md)?
