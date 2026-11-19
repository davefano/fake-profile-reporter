import { defineConfig } from 'wxt';

// Where reports go. Override at build time, e.g.
//   WXT_API_BASE=https://flr.example.workers.dev bun run build
const API_BASE = process.env.WXT_API_BASE ?? 'http://localhost:8787';

export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'Fake LinkedIn Reporter',
    description: 'Checks LinkedIn profiles for signs of fake or scam accounts, in a side panel.',
    permissions: ['storage', 'activeTab', 'scripting'],
    host_permissions: ['https://www.linkedin.com/*', `${new URL(API_BASE).origin}/*`],
    action: { default_title: 'Toggle Fake LinkedIn Reporter side panel' },
    // Same toggle from the keyboard. Users can change it at chrome://extensions/shortcuts.
    commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+L' }, description: 'Toggle the side panel' } },
    ...(browser === 'firefox' && {
      // TODO: replace with the real add-on ID before submitting to AMO.
      browser_specific_settings: { gecko: { id: 'fake-linkedin-reporter@example.org' } },
    }),
  }),
});
