import { runFirstLoginSpaceOnboarding } from "/modules/_core/spaces/onboarding/first-login-onboarding.js";

export default async function createBigBangSpaceOnFirstLogin(context = {}) {
  if (context?.isFirstLogin !== true) {
    return;
  }

  await runFirstLoginSpaceOnboarding(context);
}
