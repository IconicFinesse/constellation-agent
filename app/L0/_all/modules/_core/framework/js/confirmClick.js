export function registerAlpineMagic() {
  const Alpine = globalThis.Alpine;
  if (!Alpine || typeof Alpine.magic !== "function" || Alpine.__spaceConfirmClickRegistered) {
    return;
  }

  Alpine.__spaceConfirmClickRegistered = true;
  Alpine.magic("confirmClick", () => (message = "Are you sure?") => globalThis.confirm(message));
}
