import * as sharedSkills from "/modules/_core/skillset/skills.js";

export const ONSCREEN_TOP_LEVEL_SKILL_FILE_PATTERN = sharedSkills.TOP_LEVEL_SKILL_FILE_PATTERN;
export const ONSCREEN_SKILL_LOAD_HOOK_KEY = "__spaceOnscreenAgentOnSkillLoad";

const listDiscoveredSkillFiles = globalThis.space.extend(
  import.meta,
  async function listDiscoveredSkillFiles(pattern = ONSCREEN_TOP_LEVEL_SKILL_FILE_PATTERN) {
    return sharedSkills.listDiscoveredSkillFiles({
      pattern
    });
  }
);

const loadOnscreenSkillIndex = globalThis.space.extend(
  import.meta,
  async function loadOnscreenSkillIndex(options = {}) {
    return sharedSkills.loadSkillIndex({
      pattern: String(options.pattern || ONSCREEN_TOP_LEVEL_SKILL_FILE_PATTERN)
    });
  }
);

export const loadOnscreenSkillCatalog = globalThis.space.extend(
  import.meta,
  async function loadOnscreenSkillCatalog() {
    const index = await loadOnscreenSkillIndex();
    return index.skills;
  }
);

export const buildOnscreenSkillsPromptSection = globalThis.space.extend(
  import.meta,
  async function buildOnscreenSkillsPromptSection() {
    const index = await loadOnscreenSkillIndex();
    return sharedSkills.buildSkillCatalogPromptSection(index, {
      loadCommand: 'await space.skills.load("id")'
    });
  }
);

export const buildOnscreenAutoLoadedSkillsPromptSection = globalThis.space.extend(
  import.meta,
  async function buildOnscreenAutoLoadedSkillsPromptSection() {
    const index = await loadOnscreenSkillIndex();
    return sharedSkills.buildAutoLoadedSkillsPromptSection(index);
  }
);

export const buildOnscreenAutoLoadedSkillTransientSections = globalThis.space.extend(
  import.meta,
  async function buildOnscreenAutoLoadedSkillTransientSections() {
    const index = await loadOnscreenSkillIndex();
    return sharedSkills.buildAutoLoadedSkillsTransientSections(index, {
      headingPrefix: "Skill",
      keyPrefix: "skill:auto",
      orderBase: -200
    });
  }
);

export const buildLoadedOnscreenSkillsPromptSection = globalThis.space.extend(
  import.meta,
  async function buildLoadedOnscreenSkillsPromptSection() {
    return sharedSkills.buildRuntimeLoadedSkillsPromptSection({
      heading: "loaded skills"
    });
  }
);

export const buildLoadedOnscreenSkillTransientSections = globalThis.space.extend(
  import.meta,
  async function buildLoadedOnscreenSkillTransientSections() {
    return sharedSkills.buildRuntimeLoadedSkillsTransientSections({
      headingPrefix: "Loaded Skill",
      keyPrefix: "skill:loaded",
      orderBase: -100
    });
  }
);

export const buildOnscreenSkillPromptContext = globalThis.space.extend(
  import.meta,
  async function buildOnscreenSkillPromptContext(options = {}) {
    const includeCatalog = options.includeCatalog !== false;
    const includeAutoLoaded = options.includeAutoLoaded !== false;
    const includeRuntimeLoaded = options.includeRuntimeLoaded !== false;
    const catalogIndex = includeCatalog ? await loadOnscreenSkillIndex() : null;
    const autoLoadedIndex = includeAutoLoaded
      ? await loadOnscreenSkillIndex()
      : null;

    return {
      catalogSection: includeCatalog
        ? sharedSkills.buildSkillCatalogPromptSection(catalogIndex, {
            loadCommand: 'await space.skills.load("id")'
          })
        : "",
      autoLoadedSkillsSection: includeAutoLoaded
        ? sharedSkills.buildAutoLoadedSkillsPromptSection(autoLoadedIndex)
        : "",
      autoLoadedTransientSections: includeAutoLoaded
        ? sharedSkills.buildAutoLoadedSkillsTransientSections(autoLoadedIndex, {
            headingPrefix: "Skill",
            keyPrefix: "skill:auto",
            orderBase: -200
          })
        : [],
      loadedSkillsSection: includeRuntimeLoaded
        ? sharedSkills.buildRuntimeLoadedSkillsPromptSection({
            heading: "loaded skills"
          })
        : "",
      loadedTransientSections: includeRuntimeLoaded
        ? sharedSkills.buildRuntimeLoadedSkillsTransientSections({
            headingPrefix: "Loaded Skill",
            keyPrefix: "skill:loaded",
            orderBase: -100
          })
        : []
    };
  }
);

export const loadOnscreenSkill = globalThis.space.extend(
  import.meta,
  async function loadOnscreenSkill(path) {
    const loadedSkill = {
      __spaceSkill: true,
      ...(await sharedSkills.loadSkill({
        path
      }))
    };
    loadedSkill.loadResponseText = sharedSkills.getSkillLoadResponseText(loadedSkill);
    sharedSkills.registerLoadedSkill(loadedSkill);

    const onSkillLoad = globalThis[ONSCREEN_SKILL_LOAD_HOOK_KEY];

    if (typeof onSkillLoad === "function") {
      try {
        onSkillLoad(loadedSkill);
      } catch {
        // Skill-load tracking should not prevent the skill itself from loading.
      }
    }

    return loadedSkill;
  }
);

export const installOnscreenSkillRuntime = globalThis.space.extend(
  import.meta,
  async function installOnscreenSkillRuntime() {
    globalThis.space.skills = {
      ...(globalThis.space.skills && typeof globalThis.space.skills === "object" ? globalThis.space.skills : {}),
      load: loadOnscreenSkill
    };

    return globalThis.space.skills;
  }
);
