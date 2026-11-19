// LinkedIn's internal endpoints. Unofficial and versioned: when LinkedIn ships a
// new web build, query IDs and decoration versions can change. Keep them here.
// See docs/linkedin-data-sources.md.

export const endpoints = {
  /** Slug or profile ID → fsd_profile URN + versionTag. */
  resolve: (memberIdentity: string) =>
    `/voyager/api/graphql?includeWebMetadata=true&variables=(memberIdentity:${encodeURIComponent(memberIdentity)})` +
    '&queryId=voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a',

  /** Full profile: identity, flags, photos, positions, education, skills. */
  fullProfile: (slug: string) =>
    `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}` +
    '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93',

  /** Exact follower count. */
  followingState: (profileId: string) =>
    `/voyager/api/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:${profileId}`,

  /** Server-rendered profile page; we only keep its connection/follower count text. */
  profilePage: (slug: string) => `/in/${encodeURIComponent(slug)}/`,

  // --- companies ---
  /** Public company page (logged out). */
  companyPage: (slug: string) => `/company/${encodeURIComponent(slug)}/`,
  /** Company record, signed in. */
  companyRecord: (slug: string) =>
    `/voyager/api/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(slug)}`,
  /** The company People tab's search, 12 current employees. The queryId hash rotates with deploys. */
  companyPeople: (companyId: number) =>
    `/voyager/api/graphql?includeWebMetadata=true&variables=(start:0,origin:FACETED_SEARCH,query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,queryParameters:List((key:currentCompany,value:List(${companyId})),(key:resultType,value:List(ORGANIZATION_ALUMNI))),includeFiltersInResponse:false),count:12)&queryId=voyagerSearchDashClusters.e438ab99259203e9c1cd3f358e217282`,

  // --- jobs ---
  /** Public job posting fragment (logged out). */
  jobPosting: (jobId: string) => `/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`,
  /** Job record, signed in: apply link, listing dates, state, hiring team. */
  jobRecord: (jobId: string) =>
    `/voyager/api/jobs/jobPostings/${encodeURIComponent(jobId)}?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65`,
  /** Signed-in job page (~1.3 MB); only read for the "Verified job" badge. */
  jobPage: (jobId: string) => `/jobs/view/${encodeURIComponent(jobId)}/`,
};

const ABOUT_SCREEN = 'com.linkedin.sdui.flagshipnav.trustverifications.ProfileVerificationDetailsDialog';
const ACTIVITY_COMPONENT = 'com.linkedin.sdui.generated.profile.dsl.impl.profileCardsActivity';

/** "About this member" dialog: join date, verifications, recent photo/contact changes. */
export function aboutRequest(profileId: string, slug: string) {
  return {
    url: `/flagship-web/rsc-action/actions/navigation?screenId=${ABOUT_SCREEN}&sduiid=${ABOUT_SCREEN}`,
    body: {
      clientArguments: {
        $type: 'proto.sdui.actions.requests.RequestedArguments',
        requestedStateKeys: [],
        payload: {
          vieweeProfileId: profileId,
          entryPoint: 6,
          profileRefreshKey: slug,
          triggerRefKey: `ProfileVerificationTriggerRef-${slug}`,
        },
        requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
        states: [],
        screenId: ABOUT_SCREEN,
        knownTemplateIds: [],
      },
      isModal: true,
    },
  };
}

/** Profile "Activity" card: recent post IDs (which encode timestamps) and follower count. */
export function activityRequest(slug: string) {
  return {
    url: `/flagship-web/rsc-action/actions/component?componentId=${ACTIVITY_COMPONENT}&sduiid=${ACTIVITY_COMPONENT}`,
    body: {
      componentId: ACTIVITY_COMPONENT,
      clientArguments: {
        payload: { isSelfView: false, vanityName: slug },
        states: [],
        requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
        screenId: 'com.linkedin.sdui.flagshipnav.home.Home',
        knownTemplateIds: [],
      },
    },
  };
}
