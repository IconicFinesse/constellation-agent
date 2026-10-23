import { runLoginHooksBootstrap } from "/modules/_core/login_hooks/login-hooks.js";

export default async function loginHooksInitializerEnd() {
  await runLoginHooksBootstrap();
}
