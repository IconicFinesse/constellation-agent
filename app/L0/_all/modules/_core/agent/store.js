import {
  AGENT_PERSONALITY_PATH,
  loadAgentPersonality,
  saveAgentPersonality
} from "/modules/_core/agent/storage.js";

function logAgentPageError(context, error) {
  console.error(`[agent-page] ${context}`, error);
}

const model = {
  lastSavedPersonalityText: "",
  loading: false,
  personalityText: "",
  saving: false,
  statusText: "",
  statusTone: "",

  async init() {
    this.loading = true;
    this.setStatus("");

    try {
      const personalityText = await loadAgentPersonality();
      this.personalityText = personalityText;
      this.lastSavedPersonalityText = personalityText;
      this.setStatus(
        personalityText
          ? `Loaded personality instructions from ${AGENT_PERSONALITY_PATH}.`
          : "No personality instructions saved yet."
      );
    } catch (error) {
      logAgentPageError("loadAgentPersonality failed", error);
      this.setStatus(String(error?.message || "Unable to load agent personality."), "error");
    } finally {
      this.loading = false;
    }
  },

  get isDirty() {
    return this.personalityText !== this.lastSavedPersonalityText;
  },

  async reloadPersonality() {
    if (this.loading || this.saving) {
      return;
    }

    this.loading = true;
    this.setStatus("Reloading personality instructions...");

    try {
      const nextText = await loadAgentPersonality();
      this.personalityText = nextText;
      this.lastSavedPersonalityText = nextText;
      this.setStatus(
        nextText
          ? `Reloaded personality instructions from ${AGENT_PERSONALITY_PATH}.`
          : `Personality instructions are currently empty.`
      );
    } catch (error) {
      logAgentPageError("reloadPersonality failed", error);
      this.setStatus(String(error?.message || "Unable to reload agent personality."), "error");
    } finally {
      this.loading = false;
    }
  },

  async savePersonality() {
    if (this.loading || this.saving) {
      return;
    }

    this.saving = true;
    this.setStatus(`Saving ${AGENT_PERSONALITY_PATH}...`);

    try {
      await saveAgentPersonality(this.personalityText);
      this.lastSavedPersonalityText = this.personalityText;
      this.setStatus(`Saved personality instructions to ${AGENT_PERSONALITY_PATH}.`, "success");
    } catch (error) {
      logAgentPageError("savePersonality failed", error);
      this.setStatus(String(error?.message || "Unable to save agent personality."), "error");
    } finally {
      this.saving = false;
    }
  },

  setStatus(text = "", tone = "") {
    this.statusText = String(text || "");
    this.statusTone = String(tone || "");
  }
};

globalThis.space.fw.createStore("agentPage", model);
