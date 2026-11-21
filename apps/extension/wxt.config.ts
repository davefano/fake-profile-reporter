import { defineConfig } from 'wxt';
import { COMMUNITY_URL } from './lib/config';

// Where saves go is a setting (Settings › Save to). The community database is
// allowed up front; "My own server" asks for its address when it's connected.
const ANY_SERVER = ['https://*/*', 'http://*/*'];

export default defineConfig({
  manifest: ({ browser, manifestVersion }) => ({
    name: 'Fake LinkedIn Reporter',
    description: 'Checks LinkedIn profiles for signs of fake or scam accounts, in a side panel.',
    // unlimitedStorage: saves keep each profile's raw snapshot for uploading later.
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting'],
    // *.linkedin.com: country subdomains (uk.linkedin.com) are read as public pages.
    host_permissions: ['https://*.linkedin.com/*', ...(COMMUNITY_URL ? [`${new URL(COMMUNITY_URL).origin}/*`] : [])],
    ...(manifestVersion === 3 ? { optional_host_permissions: ANY_SERVER } : { optional_permissions: ANY_SERVER }),
    action: { default_title: 'Toggle Fake LinkedIn Reporter side panel' },
    // Same toggle from the keyboard. Users can change it at chrome://extensions/shortcuts.
    commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+L' }, description: 'Toggle the side panel' } },
    ...(browser === 'firefox' && {
      // TODO: replace with the real add-on ID before submitting to AMO.
      browser_specific_settings: { gecko: { id: 'fake-linkedin-reporter@example.org' } },
    }),
  }),
});
