import {
  changeUserPassword,
  isSingleUserRuntime,
  loadUserSettings,
  saveUserFullName
} from "/modules/_core/user/storage.js";

const PASSWORD_REDIRECT_DELAY_MS = 900;

function logUserPageError(context, error) {
  console.error(`[user-page] ${context}`, error);
}

const model = {
  currentFullName: "",
  fullNameDraft: "",
  groups: [],
  lastSavedFullName: "",
  loading: false,
  managedGroups: [],
  passwordConfirm: "",
  passwordCurrent: "",
  passwordNew: "",
  passwordSaving: false,
  passwordStatusText: "",
  passwordStatusTone: "",
  profileSaving: false,
  profileStatusText: "",
  profileStatusTone: "",
  reauthPending: false,
  singleUserApp: false,
  username: "",

  async init() {
    this.singleUserApp = isSingleUserRuntime();
    this.loading = true;
    this.setProfileStatus("");

    try {
      await this.loadSettings("Account settings loaded.");
    } catch (error) {
      logUserPageError("init failed", error);
      this.setProfileStatus(String(error?.message || "Unable to load account settings."), "error");
    } finally {
      this.loading = false;
    }
  },

  get canChangePassword() {
    return Boolean(
      !this.loading &&
        !this.passwordSaving &&
        !this.reauthPending &&
        !this.singleUserApp &&
        this.passwordCurrent &&
        this.passwordNew &&
        this.passwordConfirm &&
        !this.passwordMismatch
    );
  },

  get displayFullName() {
    return this.currentFullName || this.username || "User";
  },

  get isFullNameDirty() {
    return this.fullNameDraft !== this.lastSavedFullName;
  },

  get passwordMismatch() {
    return Boolean(this.passwordConfirm) && this.passwordNew !== this.passwordConfirm;
  },

  async loadSettings(successText = "") {
    const loaded = await loadUserSettings();

    this.username = loaded.identity.username;
    this.currentFullName = loaded.fullName;
    this.fullNameDraft = loaded.fullName;
    this.lastSavedFullName = loaded.fullName;
    this.groups = [...loaded.identity.groups];
    this.managedGroups = [...loaded.identity.managedGroups];

    if (successText) {
      this.setProfileStatus(successText);
    }
  },

  async reloadProfile() {
    if (this.loading || this.profileSaving || this.passwordSaving || this.reauthPending) {
      return;
    }

    this.loading = true;
    this.setProfileStatus("Refreshing account settings...");

    try {
      await this.loadSettings("Account settings refreshed.");
    } catch (error) {
      logUserPageError("reloadProfile failed", error);
      this.setProfileStatus(String(error?.message || "Unable to reload account settings."), "error");
    } finally {
      this.loading = false;
    }
  },

  async saveFullName() {
    if (this.loading || this.profileSaving || this.passwordSaving || this.reauthPending) {
      return;
    }

    this.profileSaving = true;
    this.setProfileStatus("Saving profile...");

    try {
      const result = await saveUserFullName(this.fullNameDraft, {
        username: this.username
      });
      this.currentFullName = result.fullName;
      this.fullNameDraft = result.fullName;
      this.lastSavedFullName = result.fullName;
      this.setProfileStatus("Profile updated.", "success");
    } catch (error) {
      logUserPageError("saveFullName failed", error);
      this.setProfileStatus(String(error?.message || "Unable to save account settings."), "error");
    } finally {
      this.profileSaving = false;
    }
  },

  clearPasswordForm() {
    this.passwordCurrent = "";
    this.passwordNew = "";
    this.passwordConfirm = "";
  },

  async changePassword() {
    if (this.singleUserApp) {
      this.setPasswordStatus("Password sign-in is not available here.", "error");
      return;
    }

    if (this.passwordMismatch) {
      this.setPasswordStatus("New password and confirmation must match.", "error");
      return;
    }

    if (!this.canChangePassword) {
      this.setPasswordStatus("Enter the current password, a new password, and a matching confirmation.", "error");
      return;
    }

    this.passwordSaving = true;
    this.setPasswordStatus("Changing password...");

    try {
      const result = await changeUserPassword(this.passwordCurrent, this.passwordNew);
      this.clearPasswordForm();
      this.reauthPending = Boolean(result?.signedOut);
      this.setPasswordStatus(
        this.reauthPending
          ? "Password changed. Redirecting so you can sign in again."
          : "Password changed.",
        "success"
      );

      if (this.reauthPending) {
        window.setTimeout(() => {
          window.location.assign("/login");
        }, PASSWORD_REDIRECT_DELAY_MS);
      }
    } catch (error) {
      logUserPageError("changePassword failed", error);
      this.setPasswordStatus(String(error?.message || "Unable to change password."), "error");
    } finally {
      this.passwordSaving = false;
    }
  },

  setPasswordStatus(text = "", tone = "") {
    this.passwordStatusText = String(text || "");
    this.passwordStatusTone = String(tone || "");
  },

  setProfileStatus(text = "", tone = "") {
    this.profileStatusText = String(text || "");
    this.profileStatusTone = String(tone || "");
  }
};

globalThis.space.fw.createStore("userPage", model);
