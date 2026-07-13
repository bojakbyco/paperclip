# Telemetry Workflow

This is the public contributor workflow for proposing first-party Paperclip
product telemetry and later promoting accepted proposals to the typed telemetry
contract.

Use this workflow when a product change needs a new event but the generated
contract in `packages/shared/src/telemetry/generated/paperclip-telemetry.ts` does
not contain that event yet.

## Propose An Event

Use `trackProposed()` only for first-party Paperclip product telemetry. Do not
use it for plugin, third-party, test, debug, or ad-hoc analytics events.

`trackProposed()` is the planned canonical helper for this workflow and may not
be available in every checkout yet. Before adding proposal call sites, check the
current telemetry client README and exports; when the helper is not present,
follow the current telemetry client guidance instead of assuming it has shipped.

The proposed event name is the future canonical event name. Do not prefix it
with `proposed.`.

Event names and dimension keys must match this grammar:

```text
^[a-z0-9][a-z0-9._:-]{1,63}$
```

That means 2-64 lowercase characters, numbers, dots, underscores, colons, and
hyphens, starting with a lowercase letter or number. Prefer
`<feature_namespace>.<action_or_outcome>`, for example
`skill_studio.skill_created`.

These namespaces are not proposal-eligible: `plugin.*`, `third_party.*`,
`external.*`, `test.*`, and `debug.*`.

Every proposed call site must include a rationale marker immediately above the
call or on the same line:

```ts
// telemetry-proposal: issue=https://github.com/paperclipai/paperclip/issues/123; rationale=measure Skill Studio create completion
trackProposed("skill_studio.skill_created", {
  sharing_scope: scope,
  category_count: categories.length
});
```

The `issue` marker must be a public `paperclipai/paperclip` GitHub issue or PR
URL. The `rationale` marker should say what product or reliability decision this
event will inform. It is source-review context, not telemetry payload.

## Dimension Rules

Keep proposal dimensions deliberately small and reviewable:

- Use an inline object literal with at most 20 keys.
- Use only primitive values: `string`, finite `number`, or `boolean`.
- Do not emit `null`, arrays, objects, bigint, functions, symbols, `NaN`, or
  infinities.
- Cap string values at 256 characters.
- Use low-cardinality operational values or explicitly hashed/normalized refs.
- Never send prompts, transcripts, document bodies, issue bodies, local paths,
  hostnames, repository remotes, command strings, secrets, tokens, emails, URLs,
  or arbitrary free text.

If a value is private before hashing or normalization, hash or normalize it
before emission and make that behavior obvious at the call site. Do not rely on
backend review to clean up sensitive client payloads.

## Static Extractability

Proposal inventory is based on static extraction. Keep call sites extractable:

- Import and call the canonical `trackProposed` helper from the telemetry client
  when it is available in your checkout.
- Pass a string literal event name. Do not use variables, template literals,
  concatenation, or helper calls for the name.
- Pass an inline object expression for dimensions. Do not use object variables,
  spreads, computed keys, conditional object construction, or nested objects.
- Use literal identifier keys or literal string keys matching the telemetry
  grammar.
- Keep every dimension value statically typed as `string`, `number`, or
  `boolean`. Avoid `any`, `unknown`, nullable values, and unions containing
  non-primitives.

When multiple call sites use the same proposed event, they must agree on the
primitive type for each shared dimension key.

Run the extractor before opening the PR when it is available in your checkout:

```bash
node scripts/extract-proposed-events.mjs
```

The extractor output uses `track-proposed-extractor.v1` and lists proposal names,
dimension names and primitive types, rationale, and file/line provenance. The PR
annotation should show the same proposed call sites without requiring repository
secrets.

## PR Checklist For Proposals

Before asking for review on a proposal PR:

- Confirm the event answers a concrete product or reliability question.
- Confirm no existing generated event answers the same question.
- Confirm every dimension is low-cardinality and public-contract safe.
- Confirm every proposed call site has the `telemetry-proposal` marker.
- Run the narrow checks for the code path you changed.
- Run the extractor if `scripts/extract-proposed-events.mjs` exists in your
  checkout.

A proposed event may be accepted, rejected, renamed, or held for more evidence.
Keep proposal names easy to rename: do not expose them in user-facing copy,
configuration, saved data, or public APIs.

## Promote An Accepted Event

Promotion happens after the generated telemetry contract includes the event in
`packages/shared/src/telemetry/generated/paperclip-telemetry.ts`.

For each accepted event:

1. Add a first-party helper in `packages/shared/src/telemetry/events.ts` when a
   stable helper API makes the emitter clearer.
2. Replace `trackProposed("<event>", { ... })` with that helper or direct
   `client.track("<event>", { ... })` when a helper would add no value.
3. Apply any event or dimension renames made during contract review.
4. Keep emitters raw. Do not lowercase, alias-map, or normalize enum-like values
   unless the generated contract explicitly requires that emitted value.
5. Use shared constants from `packages/shared/src/constants.ts` for enum-like
   dimensions when they already exist.
6. Remove the `telemetry-proposal` marker from promoted call sites.
7. Add or update focused tests for helper behavior and privacy-preserving
   hashing or normalization.

For rejected events, remove the `trackProposed()` call site instead of converting
it to dynamic telemetry.

Verify a promotion with at least:

```bash
pnpm --filter @paperclipai/shared typecheck
pnpm vitest run \
  packages/shared/src/telemetry/readme-contract.test.ts \
  packages/shared/src/telemetry/client-types.test.ts
```

If the promoted call site lives outside `packages/shared`, also run the narrow
server or UI test that covers the emitting path.

The promotion is complete when no accepted or rejected proposal call sites remain
for the feature and the extractor no longer reports those proposal names.
