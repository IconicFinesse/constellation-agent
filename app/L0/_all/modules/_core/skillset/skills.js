import { getTags } from "../framework/js/context.js";

export const TOP_LEVEL_SKILL_FILE_PATTERN = "modules/*/*/ext/skills/*/SKILL.md";
export const SKILL_FILE_NAME = "SKILL.md";
export const SKILLS_ROOT_SEGMENT = "/ext/skills/";
export const SKILL_PLACEMENT = Object.freeze({
  HISTORY: "history",
  SYSTEM: "system",
  TRANSIENT: "transient"
});

const BOOLEAN_FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const SKILL_TAG_PATTERN = /^[A-Za-z0-9._:/-]+$/u;
const VALID_SKILL_PLACEMENTS = new Set(Object.values(SKILL_PLACEMENT));

function readMetadataBooleanValue(value) {
  if (value === true || value === 1) {
    return true;
  }

  if (value === false || value === 0 || value == null) {
    return false;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (BOOLEAN_FALSE_VALUES.has(normalizedValue)) {
    return false;
  }

  if (BOOLEAN_TRUE_VALUES.has(normalizedValue)) {
    return true;
  }

  return null;
}

export function normalizeSkillSegment(segment) {
  const value = String(segment || "").trim();

  if (!value || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`Invalid skill path segment: ${segment}`);
  }

  return value;
}

export function normalizeSkillPath(path) {
  const rawPath = String(path || "").trim().replace(/^\/+|\/+$/gu, "");

  if (!rawPath) {
    throw new Error("Skill path must not be empty.");
  }

  return rawPath
    .split("/")
    .filter(Boolean)
    .map((segment) => normalizeSkillSegment(segment))
    .join("/");
}

function normalizeSkillTag(tag) {
  const value = String(tag || "").trim();

  if (!value) {
    return "";
  }

  if (!SKILL_TAG_PATTERN.test(value)) {
    throw new Error(`Invalid skill context tag: ${tag}`);
  }

  return value;
}

function parseTagString(value) {
  const rawValue = String(value || "").trim();

  if (!rawValue) {
    return [];
  }

  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    try {
      const parsedValue = JSON.parse(rawValue);
      return normalizeSkillTags(parsedValue);
    } catch {
      // Fall through to plain-text parsing.
    }
  }

  return rawValue
    .split(/[\s,]+/u)
    .map((tag) => {
      try {
        return normalizeSkillTag(tag);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export function normalizeSkillTags(value) {
  const tags = Array.isArray(value) ? value : [value];
  const uniqueTags = new Set();

  tags.forEach((entry) => {
    if (Array.isArray(entry)) {
      normalizeSkillTags(entry).forEach((tag) => uniqueTags.add(tag));
      return;
    }

    parseTagString(entry).forEach((tag) => uniqueTags.add(tag));
  });

  return [...uniqueTags].sort();
}

function normalizeSkillMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return { ...metadata };
}

export function normalizeSkillPlacement(placement) {
  const normalizedPlacement = typeof placement === "string" ? placement.trim().toLowerCase() : "";
  return VALID_SKILL_PLACEMENTS.has(normalizedPlacement)
    ? normalizedPlacement
    : SKILL_PLACEMENT.HISTORY;
}

function resolveSkillPlacement(placement, options = {}) {
  const normalizedPlacement = normalizeSkillPlacement(placement);

  if (options.autoLoaded === true && normalizedPlacement === SKILL_PLACEMENT.HISTORY) {
    return SKILL_PLACEMENT.SYSTEM;
  }

  return normalizedPlacement;
}

function normalizeSkillCondition(condition) {
  const booleanValue = readMetadataBooleanValue(condition);

  if (booleanValue === true) {
    return true;
  }

  if (booleanValue === false || condition == null) {
    return null;
  }

  if (typeof condition === "string" || Array.isArray(condition)) {
    const tags = normalizeSkillTags(condition);
    return tags.length ? { tags } : null;
  }

  if (typeof condition !== "object" || Array.isArray(condition)) {
    return null;
  }

  const tags = normalizeSkillTags(condition.tags);
  return tags.length ? { tags } : null;
}

function normalizeSkillLoadedConfig(config) {
  const booleanValue = readMetadataBooleanValue(config);

  if (booleanValue === true) {
    return true;
  }

  if (booleanValue === false || config == null) {
    return null;
  }

  return normalizeSkillCondition(config);
}

function createContextTagSet(contextTags) {
  return new Set(
    Array.isArray(contextTags) && contextTags.length ? normalizeSkillTags(contextTags) : normalizeSkillTags(getTags())
  );
}

function matchesSkillCondition(condition, contextTagSet) {
  if (condition === true || !condition) {
    return true;
  }

  return condition.tags.every((tag) => contextTagSet.has(tag));
}

function isSkillEligibleForContext(skill, contextTagSet) {
  return matchesSkillCondition(skill.when, contextTagSet);
}

function isSkillAutoLoadedForContext(skill, contextTagSet) {
  if (!isSkillEligibleForContext(skill, contextTagSet)) {
    return false;
  }

  if (skill.loaded === true) {
    return true;
  }

  if (!skill.loaded) {
    return false;
  }

  return matchesSkillCondition(skill.loaded, contextTagSet);
}

export function parseDiscoveredSkillFile(filePath) {
  const normalizedPath = String(filePath || "").trim();

  if (!normalizedPath.endsWith(`/${SKILL_FILE_NAME}`)) {
    return null;
  }

  const skillsRootIndex = normalizedPath.indexOf(SKILLS_ROOT_SEGMENT);

  if (skillsRootIndex === -1) {
    return null;
  }

  const moduleRootPath = normalizedPath.slice(0, skillsRootIndex);
  const moduleMatch = moduleRootPath.match(/^L[0-2]\/[^/]+\/modules\/([^/]+)\/([^/]+)$/u);

  if (!moduleMatch) {
    return null;
  }

  const relativeSkillPath = normalizedPath.slice(
    skillsRootIndex + SKILLS_ROOT_SEGMENT.length,
    -`/${SKILL_FILE_NAME}`.length
  );

  try {
    return {
      filePath: normalizedPath,
      modulePath: `/modules/${moduleMatch[1]}/${moduleMatch[2]}`,
      path: normalizeSkillPath(relativeSkillPath)
    };
  } catch {
    return null;
  }
}

function normalizePromptSkill(skill) {
  if (!skill || typeof skill !== "object") {
    return null;
  }

  const path = typeof skill.path === "string" ? skill.path.trim() : "";
  const body = typeof skill.body === "string" ? skill.body.trim() : "";
  const content = typeof skill.content === "string" ? skill.content : body;

  if (!path || !body) {
    return null;
  }

  return {
    ...skill,
    body,
    content,
    filePath: typeof skill.filePath === "string" ? skill.filePath : "",
    modulePath: typeof skill.modulePath === "string" ? skill.modulePath : "",
    path,
    placement: normalizeSkillPlacement(skill.placement)
  };
}

function clonePromptSkill(skill) {
  const normalizedSkill = normalizePromptSkill(skill);
  return normalizedSkill ? { ...normalizedSkill } : null;
}

function buildPromptSkillIdentity(skill) {
  const normalizedSkill = normalizePromptSkill(skill);

  if (!normalizedSkill) {
    return "";
  }

  return `${normalizedSkill.filePath}|${normalizedSkill.path}`;
}

function comparePromptSkills(left, right) {
  const pathCompare = left.path.localeCompare(right.path);

  if (pathCompare !== 0) {
    return pathCompare;
  }

  const moduleCompare = left.modulePath.localeCompare(right.modulePath);

  if (moduleCompare !== 0) {
    return moduleCompare;
  }

  return left.filePath.localeCompare(right.filePath);
}

function buildPromptSkillList(skills) {
  const promptSkillsByIdentity = new Map();

  (Array.isArray(skills) ? skills : []).forEach((skill) => {
    const normalizedSkill = normalizePromptSkill(skill);

    if (!normalizedSkill) {
      return;
    }

    promptSkillsByIdentity.set(buildPromptSkillIdentity(normalizedSkill), normalizedSkill);
  });

  return [...promptSkillsByIdentity.values()].sort(comparePromptSkills);
}

function filterPromptSkillsByPlacement(skills, placement) {
  const normalizedPlacement = normalizeSkillPlacement(placement);
  return buildPromptSkillList(skills).filter((skill) => skill.placement === normalizedPlacement);
}

function createSkillPromptRuntime() {
  const loadedSkillsByIdentity = new Map();

  return {
    clear() {
      loadedSkillsByIdentity.clear();
    },
    list(placement) {
      const skills = [...loadedSkillsByIdentity.values()];
      return placement ? filterPromptSkillsByPlacement(skills, placement) : buildPromptSkillList(skills);
    },
    remember(skill) {
      const normalizedSkill = normalizePromptSkill(skill);

      if (!normalizedSkill) {
        return null;
      }

      const identity = buildPromptSkillIdentity(normalizedSkill);

      if (!identity) {
        return null;
      }

      if (normalizedSkill.placement === SKILL_PLACEMENT.HISTORY) {
        loadedSkillsByIdentity.delete(identity);
        return clonePromptSkill(normalizedSkill);
      }

      loadedSkillsByIdentity.set(identity, normalizedSkill);
      return clonePromptSkill(normalizedSkill);
    }
  };
}

function getSkillPromptRuntimeTarget(targetRuntime = globalThis.space, options = {}) {
  if (!targetRuntime || typeof targetRuntime !== "object") {
    return null;
  }

  const create = options.create === true;
  const existingChat =
    targetRuntime.chat && typeof targetRuntime.chat === "object"
      ? targetRuntime.chat
      : targetRuntime.currentChat && typeof targetRuntime.currentChat === "object"
        ? targetRuntime.currentChat
        : null;

  if (!existingChat && !create) {
    return null;
  }

  const chatRuntime = existingChat || {};

  if (create) {
    targetRuntime.chat = chatRuntime;
    delete targetRuntime.currentChat;
  }

  if ((!chatRuntime.skills || typeof chatRuntime.skills !== "object") && create) {
    chatRuntime.skills = createSkillPromptRuntime();
  }

  return chatRuntime.skills && typeof chatRuntime.skills === "object" ? chatRuntime.skills : null;
}

export function ensureSkillPromptRuntime(targetRuntime = globalThis.space) {
  return getSkillPromptRuntimeTarget(targetRuntime, {
    create: true
  });
}

export function registerLoadedSkill(skill, options = {}) {
  const runtime = ensureSkillPromptRuntime(options.runtime);
  return runtime?.remember?.(skill) || null;
}

export function listRuntimeLoadedSkills(options = {}) {
  const runtime = getSkillPromptRuntimeTarget(options.runtime);
  return runtime?.list?.(options.placement) || [];
}

export function getSkillLoadResponseText(skill) {
  const placement = normalizeSkillPlacement(skill?.placement);

  if (placement === SKILL_PLACEMENT.SYSTEM) {
    return "skill loaded to system message";
  }

  if (placement === SKILL_PLACEMENT.TRANSIENT) {
    return "skill loaded to transient area";
  }

  return "";
}

function formatSkillPromptBlock(skill) {
  const normalizedSkill = normalizePromptSkill(skill);
  return normalizedSkill ? `id: ${normalizedSkill.path}\n${normalizedSkill.body}` : "";
}

function createSkillTransientSection(skill, options = {}) {
  const normalizedSkill = normalizePromptSkill(skill);

  if (!normalizedSkill) {
    return null;
  }

  const headingPrefix = typeof options.headingPrefix === "string" ? options.headingPrefix.trim() : "Skill";
  const keyPrefix = typeof options.keyPrefix === "string" ? options.keyPrefix.trim() : "skill";
  const orderBase = Number.isFinite(options.orderBase) ? Number(options.orderBase) : 0;
  const orderOffset = Number.isFinite(options.orderOffset) ? Number(options.orderOffset) : 0;

  return {
    content: formatSkillPromptBlock(normalizedSkill),
    heading: `${headingPrefix} ${normalizedSkill.path}`.trim(),
    key: `${keyPrefix}:${normalizedSkill.path}`,
    order: orderBase + orderOffset
  };
}

function buildSkillListLines(skills) {
  return skills.map((skill) => {
    const description = skill.description ? `|${skill.description}` : "";
    return `${skill.path}|${skill.name}${description}`;
  });
}

function buildSkillConflictLines(conflicts) {
  if (!conflicts.length) {
    return [];
  }

  return [
    "conflicting skill ids:",
    ...conflicts.map((conflict) => {
      const modules = conflict.entries.map((entry) => entry.modulePath).join(", ");
      return `${conflict.path}|conflict|${modules}`;
    })
  ];
}

export function buildSkillFilePattern(path) {
  return `modules/*/*/ext/skills/${normalizeSkillPath(path)}/${SKILL_FILE_NAME}`;
}

export async function listDiscoveredSkillFiles(options = {}) {
  const pattern = String(options.pattern || TOP_LEVEL_SKILL_FILE_PATTERN);
  const body = {
    patterns: [pattern]
  };

  if (Number.isInteger(options.maxLayer)) {
    body.maxLayer = options.maxLayer;
  }

  let result;

  try {
    result = await globalThis.space.api.call("file_paths", {
      body,
      method: "POST"
    });
  } catch (error) {
    throw new Error(`Unable to list skills: ${error.message}`);
  }

  const matchedPaths = Array.isArray(result?.[pattern]) ? result[pattern] : [];
  const effectiveSkillFiles = new Map();

  matchedPaths.forEach((matchedPath) => {
    const skillFile = parseDiscoveredSkillFile(matchedPath);

    if (!skillFile) {
      return;
    }

    effectiveSkillFiles.set(`${skillFile.modulePath}|${skillFile.path}`, skillFile);
  });

  return [...effectiveSkillFiles.values()].sort((left, right) => {
    const pathCompare = left.path.localeCompare(right.path);

    if (pathCompare !== 0) {
      return pathCompare;
    }

    const moduleCompare = left.modulePath.localeCompare(right.modulePath);

    if (moduleCompare !== 0) {
      return moduleCompare;
    }

    return left.filePath.localeCompare(right.filePath);
  });
}

async function readSkillFiles(skillFiles) {
  if (!skillFiles.length) {
    return [];
  }

  let result;

  try {
    result = await globalThis.space.api.fileRead({
      files: skillFiles.map((skillFile) => skillFile.filePath)
    });
  } catch (error) {
    throw new Error(`Unable to read skills: ${error.message}`);
  }

  const files = Array.isArray(result?.files) ? result.files : [];
  const fileMap = new Map(
    files.map((file) => [String(file?.path || ""), String(file?.content || "")])
  );

  return skillFiles.map((skillFile) => {
    const content = fileMap.get(skillFile.filePath) || "";
    const parsedDocument = globalThis.space.utils.markdown.parseDocument(content);
    const frontmatter =
      parsedDocument?.frontmatter && typeof parsedDocument.frontmatter === "object"
        ? parsedDocument.frontmatter
        : {};
    const metadata = normalizeSkillMetadata(frontmatter.metadata);
    const loaded = normalizeSkillLoadedConfig(metadata.loaded);

    return {
      body: String(parsedDocument?.body || content),
      content,
      description: String(frontmatter.description || "").trim(),
      filePath: skillFile.filePath,
      loaded,
      metadata,
      modulePath: skillFile.modulePath,
      name: String(frontmatter.name || skillFile.path).trim() || skillFile.path,
      path: skillFile.path,
      placement: resolveSkillPlacement(metadata.placement, {
        autoLoaded: loaded !== null
      }),
      when: normalizeSkillCondition(metadata.when)
    };
  });
}

function buildSkillIndex(discoveredSkills, contextTags = []) {
  const contextTagSet = createContextTagSet(contextTags);
  const groupedSkills = new Map();

  discoveredSkills
    .filter((skill) => isSkillEligibleForContext(skill, contextTagSet))
    .forEach((skill) => {
      if (!groupedSkills.has(skill.path)) {
        groupedSkills.set(skill.path, []);
      }

      groupedSkills.get(skill.path).push(skill);
    });

  const conflicts = [];
  const skills = [];

  groupedSkills.forEach((entries, path) => {
    if (entries.length === 1) {
      skills.push(entries[0]);
      return;
    }

    conflicts.push({
      entries: [...entries].sort((left, right) => left.modulePath.localeCompare(right.modulePath)),
      path
    });
  });

  skills.sort((left, right) => left.path.localeCompare(right.path));
  conflicts.sort((left, right) => left.path.localeCompare(right.path));

  return {
    conflicts,
    contextTags: [...contextTagSet].sort(),
    autoLoadedSkills: skills.filter((skill) => isSkillAutoLoadedForContext(skill, contextTagSet)),
    skills
  };
}

export async function loadSkillIndex(options = {}) {
  const skillFiles = await listDiscoveredSkillFiles({
    maxLayer: options.maxLayer,
    pattern: options.pattern
  });
  const discoveredSkills = await readSkillFiles(skillFiles);

  return buildSkillIndex(discoveredSkills, options.contextTags);
}

function findConflictingSkillEntry(conflicts, skillPath) {
  return conflicts.find((conflict) => conflict.path === skillPath) || null;
}

export async function loadSkill(options = {}) {
  const skillPath = normalizeSkillPath(options.path);
  const { conflicts, skills } = await loadSkillIndex({
    contextTags: options.contextTags,
    maxLayer: options.maxLayer,
    pattern: buildSkillFilePattern(skillPath)
  });
  const conflictingEntry = findConflictingSkillEntry(conflicts, skillPath);

  if (conflictingEntry) {
    const modules = conflictingEntry.entries.map((entry) => entry.modulePath).join(", ");
    throw new Error(`Unable to load skill "${skillPath}": conflicting skill ids in ${modules}`);
  }

  const skill = skills.find((entry) => entry.path === skillPath);

  if (!skill) {
    throw new Error(`Unable to load skill "${skillPath}": skill not found.`);
  }

  return {
    ...skill
  };
}

export function buildSkillCatalogPromptSection(index, options = {}) {
  const normalizedIndex = index && typeof index === "object" ? index : {};
  const conflicts = Array.isArray(normalizedIndex.conflicts) ? normalizedIndex.conflicts : [];
  const skills = Array.isArray(normalizedIndex.skills) ? normalizedIndex.skills : [];

  if (!skills.length && !conflicts.length) {
    return "";
  }

  return [
    "skills",
    "load on demand unless auto-loaded",
    "id = ext/skills path without /SKILL.md",
    `load: ${options.loadCommand || 'await space.skills.load("id")'}`,
    skills.length ? "skills id|name|description↓" : "no loadable skills",
    ...buildSkillListLines(skills),
    ...buildSkillConflictLines(conflicts)
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildAutoLoadedSkillsPromptSection(index) {
  const systemSkills = filterPromptSkillsByPlacement(index?.autoLoadedSkills, SKILL_PLACEMENT.SYSTEM);

  if (!systemSkills.length) {
    return "";
  }

  return [
    "auto loaded",
    ...systemSkills.map((skill) => formatSkillPromptBlock(skill))
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAutoLoadedSkillsTransientSections(index, options = {}) {
  return filterPromptSkillsByPlacement(index?.autoLoadedSkills, SKILL_PLACEMENT.TRANSIENT)
    .map((skill, indexOffset) =>
      createSkillTransientSection(skill, {
        ...options,
        headingPrefix:
          typeof options.headingPrefix === "string" && options.headingPrefix.trim()
            ? options.headingPrefix
            : "Skill",
        keyPrefix:
          typeof options.keyPrefix === "string" && options.keyPrefix.trim()
            ? options.keyPrefix
            : "skill:auto",
        orderOffset: indexOffset
      })
    )
    .filter(Boolean);
}

export function buildRuntimeLoadedSkillsPromptSection(options = {}) {
  const systemSkills = listRuntimeLoadedSkills({
    placement: SKILL_PLACEMENT.SYSTEM,
    runtime: options.runtime
  });

  if (!systemSkills.length) {
    return "";
  }

  return [
    typeof options.heading === "string" && options.heading.trim() ? options.heading.trim() : "loaded skills",
    ...systemSkills.map((skill) => formatSkillPromptBlock(skill))
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildRuntimeLoadedSkillsTransientSections(options = {}) {
  return listRuntimeLoadedSkills({
    placement: SKILL_PLACEMENT.TRANSIENT,
    runtime: options.runtime
  })
    .map((skill, indexOffset) =>
      createSkillTransientSection(skill, {
        ...options,
        headingPrefix:
          typeof options.headingPrefix === "string" && options.headingPrefix.trim()
            ? options.headingPrefix
            : "Loaded Skill",
        keyPrefix:
          typeof options.keyPrefix === "string" && options.keyPrefix.trim()
            ? options.keyPrefix
            : "skill:loaded",
        orderOffset: indexOffset
      })
    )
    .filter(Boolean);
}
