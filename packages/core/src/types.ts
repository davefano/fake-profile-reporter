// Shapes shared by the extension and the API. Keep these stable: they are the
// wire format between clients and any directory server.

/** Raw observations scraped from a profile page. Every field is optional. */
export interface ProfileObservation {
  name?: string;
  headline?: string;
  about?: string;
  photoUrl?: string;
  hasPhoto?: boolean;
  connections?: number | null;
  /** Unparsed connection text (e.g. "500+") when no number is available. */
  connectionsText?: string | null;
  followers?: number | null;
  endorsements?: number | null;
  experienceCount?: number | null;
  accountAgeDays?: number | null;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface GradeReason {
  label: string;
  weight: number;
}

export interface GradeSignals {
  cryptoHits: string[];
  guruHits: string[];
  buzzHits: string[];
  connections: number | null;
  hasPhoto: boolean;
  endorsements: number | null;
  experienceCount: number | null;
  accountAgeDays: number | null;
  aboutLength: number;
}

export interface GradeResult {
  score: number;
  level: RiskLevel;
  reasons: GradeReason[];
  signals: GradeSignals;
}

export interface NormalizedProfileUrl {
  url: string;
  handle: string;
}

export interface ReportRequest {
  url: string;
  profile: ProfileObservation;
}

export interface LeaderboardRow {
  url: string;
  handle: string;
  name: string;
  headline: string;
  photoUrl: string;
  reports: number;
  avgScore: number;
  lastReported: number;
}

export interface LeaderboardResponse {
  stats: { reports: number; profiles: number };
  rows: LeaderboardRow[];
}
