// Bundled and injected into the LinkedIn page by capture.ts: the signed-in
// readers from the LinkedIn data layer.
import { captureProfile, fetchCompanyExtras, fetchJobExtras } from '@flr/core/linkedin';

(globalThis as any).__flrCapture = captureProfile;
(globalThis as any).__flrCompanyExtras = fetchCompanyExtras;
(globalThis as any).__flrJobExtras = fetchJobExtras;
