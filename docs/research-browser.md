# Research browser

A persistent [agent-browser](https://github.com/vercel-labs/agent-browser)
session, signed in to LinkedIn, used for mapping endpoints and for
`bun run capture`. The user signs in by hand in the headed window.

```bash
export AGENT_BROWSER_SESSION=linkedin \
  AGENT_BROWSER_PROFILE=$HOME/.agent-browser/profiles/linkedin \
  AGENT_BROWSER_EXECUTABLE_PATH=/opt/google/chrome/chrome \
  AGENT_BROWSER_HEADED=1
agent-browser open https://www.linkedin.com/feed/
```

- If it's signed out, ask the user to sign in again in the window. Don't copy
  cookies in from another browser (see AGENTS.md).
- Read-only: replay requests with `agent-browser eval --stdin` and
  `fetch(...)` in the page. Never click anything that changes state.
- `agent-browser network requests` lists what a page loads. HAR files have
  empty bodies for voyager and RSC responses, so replay those instead.
- Keep volume to a handful of profiles, companies or jobs per task.
- It is signed in as a different LinkedIn account from the user's own, so it sees what an outsider sees: photos limited to the member's network show as placeholders, and connection degree and mutual connections differ from what the user sees.
