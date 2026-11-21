# LinkedIn data sources

Research notes on where profile data comes from, as of November 2026. All of
these are **unofficial, undocumented internal endpoints**. They change without
notice, and query IDs and decoration versions especially.

Every request runs from the extension's content script on `www.linkedin.com`,
using the viewer's own session. Voyager calls need these headers:

```
csrf-token: <JSESSIONID cookie value, without quotes>
accept: application/vnd.linkedin.normalized+json+2.1
x-restli-protocol-version: 2.0.0
```

## Identifiers

| ID | Example | Stable? | Notes |
|---|---|---|---|
| Slug / `publicIdentifier` | `williamhgates` | **No.** Users can change it. | Appears in `/in/<slug>` URLs. |
| Profile ID (`fsd_profile`) | `ACoAAA8BYqEBCGLg_vT_ca6mMEqkpp9nVffJ3hc` | Yes | Base64url. |
| Member ID (`urn:li:member:<n>`) | `251749025` | Yes | **This is the key to track profiles by.** |

**The member ID is encoded in the profile ID.** Base64url-decode the profile ID
and read bytes 4–7 as a big-endian uint32:

```ts
const memberId = Buffer.from(profileId, 'base64url').readUInt32BE(4);
// in the browser: new DataView(bytes.buffer).getUint32(4)
```

**Member IDs are assigned roughly in order, so they give a rough guide to account age.** Observed pairs:

| Member ID | "Joined LinkedIn" |
|---|---|
| ~8.8M | December 2006 |
| ~251.7M | May 2013 |
| ~810.9M | April 2020 |
| ~1.81B | July 2026 |

Collect more pairs, from the *About this member* dialog below, to build an
interpolation table.

## 1. Slug to stable ID (cheap)

```
GET /voyager/api/graphql?includeWebMetadata=true
    &variables=(memberIdentity:<slug or profileId>)
    &queryId=voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a
```

Returns the `fsd_profile` URN and a `versionTag`. The `versionTag` appears to
change whenever the profile is edited, which would make it a cheap way to detect
edits. That needs confirming.

## 2. Full profile

```
GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<slug>
    &decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93
```

`included[]` contains a `…identity.profile.Profile` entity with:

- **Identity:** `entityUrn`, `objectUrn` (member ID) and `publicIdentifier`.
- **Name and text:** `firstName`, `lastName`, `maidenName`, `headline` and `summary`.
- **Flags:** `premium`, `showPremiumSubscriberBadge`, `creator`, `influencer` and `memorialized`.
- **Location and industry:** `geoLocation`, `location.countryCode` and `industryUrn`.
- **Photos:** `profilePicture` and `backgroundPicture`. The URL path segments end
  in an **upload timestamp in milliseconds**, for example
  `…/profile-displayphoto-shrink_200_200/0/1696284332069`, so you can tell how
  old the photo is.
- **History:** linked `Position`, `PositionGroup`, `Education`, `Skill` and
  `VolunteerExperience` entities, with `dateRange.start/end` given as `{month, year}`.

The older `/voyager/api/identity/profiles/<slug>/profileView` and `/networkinfo`
endpoints return **410 Gone**.

## 3. Follower count

```
GET /voyager/api/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:<profileId>
```

→ `data.followerCount` (exact).

## 4. Connection count

No voyager source found yet. The server-rendered profile page HTML contains
text such as `"2 connections"` or `"500+ connections"`. The number and the word
are often in separate elements (`<p>500+</p>…<p>connections</p>`). LinkedIn
caps the displayed number at 500+. Some profiles don't show a connection count
at all.

**The full-profile payload bundles other people.** `included[]` also holds
recommenders' and similar profiles. Pick the `Profile` whose `entityUrn`
matches the requested profile ID, and filter child records such as
`fsd_profilePosition:(<profileId>,n)` by owner.

## 5. "About this member": join date, verifications, recent changes

This is the best signal for account age. It's a server-driven UI (RSC) action,
not voyager:

```
POST /flagship-web/rsc-action/actions/navigation
     ?screenId=com.linkedin.sdui.flagshipnav.trustverifications.ProfileVerificationDetailsDialog
     &sduiid=com.linkedin.sdui.flagshipnav.trustverifications.ProfileVerificationDetailsDialog
headers: content-type: application/json, csrf-token, x-li-rsc-stream: true
body:
{
  "clientArguments": {
    "$type": "proto.sdui.actions.requests.RequestedArguments",
    "requestedStateKeys": [],
    "payload": {
      "vieweeProfileId": "<profileId>",
      "entryPoint": 6,
      "profileRefreshKey": "<slug>",
      "triggerRefKey": "ProfileVerificationTriggerRef-<slug>"
    },
    "requestMetadata": { "$type": "proto.sdui.common.RequestMetadata" },
    "states": [],
    "screenId": "com.linkedin.sdui.flagshipnav.trustverifications.ProfileVerificationDetailsDialog",
    "knownTemplateIds": []
  },
  "isModal": true
}
```

The response is an RSC flight stream (`application/octet-stream`). It contains
a UI tree, not data records. Taking the `"children":["…"]` text strings in
order gives label/value pairs:

```
Account history
Joined LinkedIn        → "May 2013"
Contact info           → "Updated over 1 year ago"
Profile photo          → "Updated less than 1 year ago"
Verifications
Identity               → "Verified by LinkedIn in April 2026"
(or "<Name> doesn’t have any verifications yet.")
```

The text is localized UI copy, so parsing depends on the viewer's language.

## 6. Activity: last post, posting frequency

Post and activity IDs (`urn:li:activity|ugcPost|share:<id>`) are
snowflake-style: **`id >> 22` is the creation time in milliseconds**. The
profile's Activity card lists recent ones:

```
POST /flagship-web/rsc-action/actions/component
     ?componentId=com.linkedin.sdui.generated.profile.dsl.impl.profileCardsActivity
     &sduiid=com.linkedin.sdui.generated.profile.dsl.impl.profileCardsActivity
headers: content-type: application/json, csrf-token, x-li-rsc-stream: true
body:
{
  "componentId": "com.linkedin.sdui.generated.profile.dsl.impl.profileCardsActivity",
  "clientArguments": {
    "payload": { "isSelfView": false, "vanityName": "<slug>" },
    "states": [],
    "requestMetadata": { "$type": "proto.sdui.common.RequestMetadata" },
    "screenId": "com.linkedin.sdui.flagshipnav.home.Home",
    "knownTemplateIds": []
  }
}
```

The response is about 6 MB of RSC for an active account (~370 KB gzipped).
Collect every post URN in it and decode the timestamps. The newest is the
account's last activity, and the count over the time span gives posting
frequency. It may include posts the user reposted, so treat it as "activity",
not "authored posts". The `/in/<slug>/recent-activity/all/` page has more posts
but is ~14 MB.

## Profile page payload (SDUI)

The `/in/<slug>/` page is server-rendered React. The data is in
`window.__como_rehydration__`, which is an array of RSC flight chunks with rows
of the form `id:json`. It's mostly UI components, but it includes
`vieweeMemberUrn`, `profileId` (`ACoAA…`) and the connection count text. Use it
as a fallback. The voyager calls above return actual data records and are
easier to work with.

## 7. Company pages (public)

`GET /company/<slug>/` without cookies returns a server-rendered page:

- **Company ID:** `urn:li:organization:<n>` in the HTML.
- **About block:** `data-test-id="about-us__<key>"` rows with `<dt>`/`<dd>`. Keys: `website` (the link goes
  through `/redir/redirect?url=`), `industry`, `size` ("501-1,000 employees"), `headquarters`,
  `organizationType`, `foundedOn`, `specialties`.
- **Followers:** the `<meta name="description">` ("Name | 11,415 followers on LinkedIn."). The top card shows
  them only sometimes.
- **Employees on LinkedIn:** `face-pile__text` ("View all 650 employees"). Comparing this with the claimed size
  is the strongest company signal.
- **Logo upload time:** the logo URL ends in `/0/<ms>`, like profile photos.
- **Recent posts:** JSON-LD `SocialMediaPosting` items with `datePublished`.

Bun's HTTP client gets 403 on these pages; browsers and curl get 200.

## 8. Job postings (public)

`GET /jobs-guest/jobs/api/jobPosting/<jobId>` without cookies returns the posting as an HTML fragment:
`top-card-layout__title`, `topcard__org-name-link` (company link, sometimes on a country subdomain such as
`uk.linkedin.com`), `topcard__flavor--bullet` (location), `posted-time-ago__text`, `num-applicants__caption`,
`compensation__salary`, `show-more-less-html__markup` (description), and `description__job-criteria-item`
rows (seniority, employment type, function, industries). `apply-link-offsite` vs `apply-link-simple` tells
an external apply from Easy Apply. Logged-out visitors don't see the external apply URL or the hiring team.

Job IDs come from `/jobs/view/<id>/`, `/jobs/view/<title>-<id>/`, or `?currentJobId=<id>` on search pages.

## 9. Logged-in extras for jobs and companies

These need the viewer's session (voyager headers as above) and run from the content script.

- **Job record:** `GET /voyager/api/jobs/jobPostings/<id>?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`
  → `applyMethod.companyApplyUrl` (external apply link), `listedAt`, `originalListedAt` (earlier when
  reposted), `expireAt`, `jobState`, `workRemoteAllowed`, `thirdPartySourced`, `trustReviewDecision`, and a
  `JobHiringTeam` entity (often empty; filled when a person posted the job). `applies` and `views` read 0.
- **Verified job:** not in the record. The logged-in `/jobs/view/<id>/` page (~1.3 MB) has
  `aria-label="Verified job"` on verified postings.
- **Company record:** `GET /voyager/api/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=<slug>`
  → `autoGenerated`, `claimable`, `paidCompany`, `staffingCompany`, `phone`, `confirmedLocations`.
- **Employees:** the People tab's search,
  `voyagerSearchDashClusters.<hash>` with `flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI` and
  `currentCompany=<id>`, 12 per page. Each result's `trackingUrn` is `urn:li:member:<id>` (or `headless` for
  hidden members), so account age can be estimated from the member ID without opening any profile. Keep
  only counts. The query hash rotates with LinkedIn deploys.
- **Mutual connections:** the logged-in profile page HTML has "Lara and David are mutual connections" or
  "A, B, and 12 other mutual connections", with names in `<strong>` tags.

## Etiquette

- Every call runs as the viewing user. Keep the volume to what a person
  browsing would generate: one profile at a time, with no crawling.
- Opening a profile records a profile view, which the profile owner may see.
