# Agent garden

One line per agent mistake, so it isn't repeated. A repeat becomes a check.

- Copied LinkedIn cookies into a second browser to test the extension; LinkedIn revoked the session everywhere. Ask the user to sign in instead.
- Sent a keyboard shortcut (`wtype`) to a locked screen and typed into the password box. Check the screen is unlocked before sending keys.
- Took the first `Profile` entity in a payload; LinkedIn bundles other people (recommenders) too. Match the requested profile ID.
- Scored missing data (hidden connections, a failed fetch) as suspicion. Missing evidence goes in "not checked".
- Treated unknown activity as "no activity" and fired a false signal. Unknown is not none.
- Read the text after the last `<strong>` name for mutual connections and miscounted. Take the whole inline run.
- Wrote real people's member IDs into tests and calibration data. Use synthetic fixtures and rounded values.
- Seated `/council` from the skill's defaults without reading `docs/dev/agent-models.md`, and called that file stray. Read the repo's model doc first.
- Read a `profilePicture` field with its image stripped out as "no photo"; the member had hidden it from the research account. Empty field = none shown to this viewer, either no photo or one limited to their network (not checked); absent field = no photo. Copy must not claim which.
