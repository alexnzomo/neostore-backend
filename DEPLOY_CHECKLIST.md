# Mwechestore — Deploy Checklist

Use this before every production deploy.

---

## Pre-Deploy

### Backend

- [ ] All tests pass locally (manual smoke test of the endpoints you changed)
- [ ] `node --check` passes on every modified `.js` file
  ```bash
  for f in $(git diff --name-only HEAD~1 | grep '\.js$'); do node --check "$f" || echo "SYNTAX ERROR: $f"; done