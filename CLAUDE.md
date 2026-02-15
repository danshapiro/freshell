# Freshell

Self-hosted, browser-accessible terminal multiplexer and session organizer. See AGENTS.md for full architecture, development philosophy, and coding rules.

@AGENTS.md

## Workflow Profile

```yaml
workflow:
  base_branch: main
  direct_to_main: false
  investigation: light               # Quick search, no Explore agent
  plan_approval: auto                # Auto-approve plans
  user_testing: skip                 # No manual testing needed
  quality_gates:
    - npm test
  review:
    triage: true                     # Use NONE/LIGHT/FULL triage
    max_level: LIGHT                 # Superpowers code-reviewer available if needed
    agents: []
  ship:
    method: pr
    target: upstream/main
    linear_status: "In Progress"
    deploy_hint: "Maintainer merges PR to upstream"
  labels:
    auto_detect: false
```

## Project Management

**Linear Team**: Platform (PLA), prefix `FRE-`

When creating Linear tickets for work in this repository:
- Use the `FRE` prefix
- Run `/start FRE-XXX` to begin work on a ticket
