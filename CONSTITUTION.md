# Constitution

## Tech stack and tooling

- Detected stack: node, typescript, react.
- Evidence:
- package.json (Node.js project manifest)
- REVIEW REQUIRED: confirm supported versions, approved libraries, and the canonical test command.

## Architectural invariants

- Keep application behavior, infrastructure boundaries, and data ownership explicit in each feature brief.
- Do not introduce a new integration, persistence boundary, or generated artifact without documenting it in that feature brief.
- Data-model locations:
- REVIEW REQUIRED: no conventional data-model directory detected.

## Agentic contract

- Do not write application code while preparing this workspace harness.
- Before ending, being interrupted, or switching tasks, append a structured handoff to `docs/state/active_session.md`.
- Read this constitution, the relevant feature brief, and the final handoff snapshot before starting work.
- Run the project test command before declaring a feature complete.

## Definition of done

- Feature acceptance criteria pass.
- Relevant tests and verification commands pass.
- The final handoff snapshot records outcome, blockers, attempted solutions, and next steps.

## Human review required

- Review CONSTITUTION.md before relying on inferred stack or architectural invariants.
- Confirm data-model locations or state that the project has none.
