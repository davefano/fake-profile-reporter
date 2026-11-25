# Score display and report flow — prototype run

Run: `docs/design/prototype/2026-11-23-score-and-report.ItbJll/`
Question dir: `01-score-display-and-report-flow/` (screen: `screens/index.html`)

## Question

1. How should the panel show a profile's suspicion, without a headline percentage, so a person can see what counts for and against it? (seeing)
2. How should Report work once reports carry a stance, reasons, certainty and a private note, and can be edited, withdrawn, or turned into a vouch? (driving)
3. Make the panel look specific to this product rather than generated.

## Baseline (current product, commit 4ed479c)

Evidence: `apps/extension/lib/panel/views.ts`, `panel.css`, `panel.ts` at HEAD; screenshots earlier in the session.

- Type: system sans, 14px base; name 16/650; level title 15/650 in the level colour; score number 40/700.
- Colour tokens: white / sunken #f4f5f7 / line #e6e8ec; accent #3451d1; high #c42a5c, med #a8650a, low #23793a; dark-mode set.
- Shape: radius 10 (one value everywhere), 8px buttons, 16px gutter.
- Layout: sticky header (shield logo tile, title, "Side Panel · host", rescan, gear), tabs This page / Saved / Reports; hero (avatar, name, headline, meta); score block (number /100, level title, sentence, 3-zone meter); 3-column facts; signal groups "Doesn't add up" / "Weak signals" / "In their favor" each with a coloured dot heading and +N weights; "Not checked"; career timeline; sticky actions bar (Track | Report as suspicious).
- Vocabulary: "suspicion score, not a verdict", "Not checked", "Track", "Report".

What reads as generated: coloured-dot section headings, the +8/−12 weight column, the number-first score with a meter, one radius on everything, a logo tile in the header.

## Options built (one surface, switch in the controls)

All three share: level in words first ("Some concerns") with a square level mark, the facts grid, "Not checked" line, a plain header (no logo tile; destination shown as "· Community"), the score number moved behind "Show the score", and the same report flow.

- **A · Two sides** (`proto_variant=balance`). Principle: weigh the evidence. Two bars (Red flags / Signs it's genuine) sized by major=3, minor=1, then two lists with major/minor tags. Answers "which side is heavier".
- **B · Reviewer's note** (`proto_variant=brief`). Principle: read it like a colleague's note. A plain-language paragraph, then findings grouped under four questions (Is it who it says it is? / Has the account changed hands? / Does the history add up? / Does anyone use it?) with ✕ / ✓ / – marks.
- **C · Checklist** (`proto_variant=audit`). Principle: show the work. Tally of red flags / fine or in favour / not checked (filters), then every check by question, including checks that passed (which the product doesn't show today).

Report flow (all variants): Save | Report… plus "Know this person? Vouch that they're real". Report… opens an inline form: stance (Looks suspicious / Someone used this person's identity / I know this person is real), reason chips per stance, I suspect it / I confirmed it (report only), optional private note ("Only stored, never shown to anyone", 0/500), Cancel / Send. After sending: one line ("You reported this profile as suspicious · reasons"), "Just now · shared with Community", Edit / Withdraw. Withdraw shows "Withdrawn. It no longer counts." Server unreachable: "Saved in this browser. Couldn't reach Community; it will send next time you open the panel." The action bar stops being sticky while the form is open.

Mocked: all data is synthetic (Sam Q., Olivia Brandt, Priya Natarajan are invented); sending is a 700 ms timeout; nothing persists across reloads.

## URL parameters (proto_v=1)

| key | values | default |
|---|---|---|
| proto_variant | balance, brief, audit | balance |
| proto_scenario | concerns (old account, changed hands), high (new recruiter), low (lived-in) | concerns |
| proto_report | none, open, reported, vouched (starting state) | none |
| proto_net | ok, offline | ok |
| proto_width | 360, 420, 500 | 420 |
| proto_theme | light, dark | system |

Unknown or invalid values fall back to the default; an unknown proto_v uses all defaults.

## Preview

- Helper: CE `light-webserver.js` (bun), root = the question dir, annotate on, bound to 127.0.0.1:44155.
- Remote (after the user ran `sudo tailscale set --operator=$USER`): helper restarted on 127.0.0.1:36253 (pid 1691524); `tailscale serve --bg --https 8443 http://127.0.0.1:36253` added, no other mappings existed. Link: https://wrek-gar.tail403edf.ts.net:8443/index.html?proto_v=1&proto_variant=balance&proto_scenario=concerns&proto_report=none&proto_net=ok&proto_width=420&proto_theme=light . Verified on the serving host over HTTPS: page renders. Annotate overlay does NOT load: the helper injects http://…/__ce-annotate/annotate.js into an HTTPS page and the browser blocks it (installed CE 3.30.1 helper lacks X-Forwarded-Proto support). Not verified from a second tailnet machine. Teardown: `tailscale serve --https=8443 off` after checking it still points at this run, then stop the helper.
- Shared instead as a private claude.ai page: https://claude.ai/artifact/CH3yPSat2qmHtUqwwYtPoA (a copy of screens/index.html without the HTML wrapper and the Copy link control, since query strings don't survive there; annotation is not available on it). The local helper has since stopped on its idle timeout.
- Compatibility note: the installed helper (compound-engineering 3.30.1) has no X-Forwarded-Proto handling, so the Annotate overlay may fail behind Tailscale HTTPS. Not patched.
- Verified locally (agent-browser, desktop 1100 px): all three variants at 420 px light; brief variant with the form open, dark, 360 px. Fixed before handoff: paragraph margins zeroed by the reset, the genuine bar hidden by a class clash, link colour overridden by the button reset, sticky form covering content.
- Not yet verified: 390 px controls toggle, copy link, remote access, annotation overlay.

## Decisions

- 2026-11-23, user: **layout A (Two sides)** wins. Next question: its visual aesthetic (techno / Linux-like, still consumer friendly), see `02-aesthetic/`.

Agent leaning (not a decision): B's question groups carry the "changed hands" story best; A's two bars are the fastest read. A combination (A's bars at the top, B's groups below) may beat either.

## Open

- Which variant, or which combination.
- Whether the score number should stay reachable at all ("Show the score").
- Report flow: whether "Someone used this person's identity" belongs in the same form or as its own link.

## Preview restarts

- 2026-11-23: the helper stopped on its 30-minute idle timeout (viewing a page is not activity). Restarted on the same port 127.0.0.1:36253 (pid 1696734) with `CE_LIGHT_WEB_IDLE_TIMEOUT_MS` = 24 h and `--owner-pid` = the user's systemd session, so it survives between agent turns. Serve mapping :8443 unchanged. Verified: HTTPS 200 and the page renders in a browser on the serving host.

## Question 02 · aesthetic (`02-aesthetic/screens/aesthetic.html`)

Layout A, three looks the user asked for ("techno Linux-y, still consumer friendly"), grounded in Omarchy's own design language on this machine: themes are 25 named colours in `colors.toml` (/usr/share/omarchy/themes), the shell sets everything in the system monospace (JetBrains Mono Nerd Font), Hyprland rounding 0 and 2px window borders, spacing 4/6/8 with 14 between panels, type 10–14px. Omarchy colour names are not meanings (Hackerman's `red` is green), so palettes supply backgrounds, text and accent only; flag/ok/warn colours are ours per palette.

All looks: square corners, Inter for sentences, JetBrains Mono (Google Fonts) for labels and data.

- **1 · Terminal, made friendly** (`proto_look=term`): hairlines and dashed row rules, monospace lowercase section labels with `n=` counts, `status: concerns`, key–value facts in one aligned column.
- **2 · Tiled panes** (`proto_look=tiled`): each section a bordered window with its title set into the top edge; the assessment pane (and the report form when open) gets the 2px accent border, like a focused Hyprland window.
- **3 · Instrument readout** (`proto_look=readout`): a boxed level readout (HI / MED / LO), segmented gauges for the two sides (major = 3 segments, minor = 1), facts as a ruled grid with mono numerals.

Palettes (`proto_pal`): tokyo-night (the user's current theme), matte-black, lumon, flexoki-light.

URL parameters (proto_v=1): proto_look term|tiled|readout (default term); proto_pal tokyo-night|matte-black|lumon|flexoki-light (default tokyo-night); proto_scenario concerns|high|low; proto_report none|open|reported; proto_net ok|offline; proto_width 360|420|500.

Preview: helper on 127.0.0.1:39853 (pid 1701489, 24 h idle, owner = user's systemd), Serve `https 8444 → 127.0.0.1:39853`. Verified over HTTPS on the serving host: term/tokyo-night, tiled/matte-black, readout/lumon at 420 px, tiled/flexoki-light at 360 px with the form open; JetBrains Mono loaded. Fixed before handoff: empty gauge segments invisible. Same annotate limitation as question 01. Teardown: `tailscale serve --https=8444 off` and stop this helper.

## Facts position (both questions)

- 2026-11-23, user: the key-facts grid should sit **higher** than the bottom of the panel. Added `proto_facts=mid|top` to both screens: `mid` (default) = right after the assessment (level + two bars), before the evidence lists; `top` = right under the profile header. Which of the two is still open. The facts now carry a rule above and below since they are no longer last.

## Look 4 · Dither (added to question 02)

- 2026-11-23, user pointed at https://tripwire.sh/dither-kit ("something like this is dope; the site is cool too"). Observed there: near-black #0f0f10 / white, Geist + a mono + Geist Pixel display, ordered-dither (Bayer) canvas fills, hatching, dithered checker rules beside section titles, generated symmetric pixel avatars, dithered gradient washes, denser dither on button hover, blue/purple accents.
- Built as `proto_look=dither` (our own canvas code, not theirs): Geist / Geist Mono / Geist Pixel from Google Fonts; the verdict in Geist Pixel at 30px; a dithered wash in the level colour in the top-right of the assessment (kept clear of the sentence after a first version made it hard to read); the two bars as Bayer-dithered gauges, dense at the start and thinning out; checker rules beside "Red flags" / "Signs it's genuine"; a mirrored 5×5 pixel avatar seeded from the name; a dot-dithered Report button that gets denser on hover; dotted rules around the facts.
- New palette `proto_pal=ink` (near-black + blue, after dither-kit). Schema: proto_look gains `dither`; proto_pal gains `ink`.
- Verified over HTTPS on the serving host: dither/ink (concerns) and dither/flexoki-light (high).

## Look 5 · Readout × Dither, tuned with DialKit

- 2026-11-23, user: likes a mix of readout/flexoki-light, dither/flexoki-light and dither/lumon; asked to tune composition and spacing with /interface-craft (DialKit).
- Built `proto_look=mix` (now the default look, default palette flexoki-light): the readout's boxed MED/HI/LO tag (set in Geist Pixel), instrument box around the gauges and ruled facts grid; the dither look's pixel heading, Bayer-dithered gauges, pixel avatar, checker rules beside section titles, top-right wash and dotted Report button.
- DialKit 2.0.0 vanilla browser build from jsDelivr (prototype only; nothing added to the project). Panel "Readout × Dither" (top right) with folders Spacing (gap, gutter, row padding, radius), Type (heading, body, fact value), Readout (tag box|dither|none, size, border), Gauges (box fill|line|none, padding, height, dot size, fade), Wash (on, density, reach, opacity), Facts (grid|lines), Avatar (size). Every dial is a CSS custom property or a canvas parameter on the real panel.
- Dial values round-trip in the URL as `proto_dial` (JSON of the values that differ from the defaults), so Copy link reproduces a tuned state; DialKit's own Copy exports all values.
- Verified over HTTPS on the serving host: panel mounts, defaults in flexoki-light; a `proto_dial` gap of 30 applies on load in lumon.
- 2026-11-23, user tuned look 5 in DialKit and asked for those values as defaults: gap 32, gutter 24, row padding 12, radius 4; heading 28, body 14, fact value 16; tag box, size 56, border 2; gauges box fill, padding 16, height 20, dot 2, fade 0.25; wash on, density 1, reach 0.3, opacity 0.35; facts lines; avatar 56 (avatar max raised to 72). Applied to the DialKit config and the matching CSS fallbacks.
- 2026-11-23, user: top-align the avatar with the name, and the MED tag with the heading. Done with `align-items: start` plus `text-box: trim-start cap alphabetic` on both headings so the cap height, not the line box, meets the top of the box. Measured: avatar and name tops equal, tag and heading tops equal.
- 2026-11-23, user: replace the sun-like settings icon with a gear (done in both screens: Lucide's cog shape; the real extension still has the old icon until the design is applied).
- 2026-11-23, user: put the colour palettes in Settings with simple descriptive names. Added a Settings screen to the aesthetic prototype (gear toggles it; `proto_view=page|settings`) with **Appearance** first: palette cards with a mini preview (background, text lines, accent/flag/ok dots), a name, a one-line description and the source theme as a small note. Names: Paper (Omarchy Flexoki Light), Slate (Lumon), Midnight (Tokyo Night), Charcoal (Matte Black), Ink (after dither-kit), plus **Match my system** (Paper by day, Slate at night; `proto_pal=system`). Below it, the existing Save to and Your saves sections. Picking a palette re-themes the panel and updates the URL.
- 2026-11-23, user: "too many fonts… just make it all Geist readable styles". Look 5 now uses **Geist only** (no Geist Mono, no Geist Pixel): weights 400 and 600; sizes 12 (labels, captions), 13 (secondary text, buttons), 14 (body), 16 (names, form title), 28 (the verdict and the Settings title); tabular figures for data; no lowercase-transformed labels. Measured in the browser on This page: families [Geist], weights [400, 600], sizes [12, 13, 14, 16, 28]. The dithered gauges, wash, checker rules and pixel avatar carry the techno feel. Inter, JetBrains Mono, Geist Mono and Geist Pixel are still loaded only for looks 1–4.
