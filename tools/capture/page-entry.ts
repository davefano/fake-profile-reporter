// Bundled and injected into the LinkedIn page by capture.ts: the signed-in
// readers from the LinkedIn data layer.
import { captureProfile, fetchCompanyExtras, fetchJobExtras } from '@fpr/core/linkedin';

(globalThis as any).__fprCapture = captureProfile;
(globalThis as any).__fprCompanyExtras = fetchCompanyExtras;
(globalThis as any).__fprJobExtras = fetchJobExtras;
