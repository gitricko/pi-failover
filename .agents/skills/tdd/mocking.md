# Mocking Guidelines

Use mocks only where you need to control a seam. A mock should replace an interface boundary (a seam), not an implementation detail.

## When to mock

- The seam doesn’t exist yet, but you can define it.
- You need determinism: time, randomness, external services, or data stores.
- You want to observe the collaboration at the seam (that a collaborator was called with correct inputs).

## When not to mock

- If the seam is already covered by real behavior, prefer an integration-style test.
- If mocking would couple the test to internal call graphs.
- If the mock’s expectations mirror the implementation rather than the contract.

## Principles

- **Mock the contract, not the internals.** Set expectations based on inputs/outputs at the seam.
- **Minimize behavior verification.** Prefer asserting externally observable outcomes.
- **Keep mocks honest.** If the real seam would behave differently, update the test.

## Example patterns

- Use fakes for complex collaborators.
- Use spies sparingly when you only need to confirm that a collaborator was used.

(Ported from mattpocock/skills engineering/tdd/mocking.md)