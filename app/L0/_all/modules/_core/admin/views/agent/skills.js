import * as sharedSkills from "/modules/_core/skillset/skills.js";

export async function loadAdminSkill(name) {
  const loadedSkill = {
    __spaceAdminSkill: true,
    ...(await sharedSkills.loadSkill({
      path: name
    })),
    skillName: sharedSkills.normalizeSkillPath(name)
  };
  loadedSkill.loadResponseText = sharedSkills.getSkillLoadResponseText(loadedSkill);
  sharedSkills.registerLoadedSkill(loadedSkill);
  return loadedSkill;
}

export function installAdminSkillRuntime() {
  const adminRuntime = {
    ...(globalThis.space.admin && typeof globalThis.space.admin === "object" ? globalThis.space.admin : {}),
    loadSkill: loadAdminSkill
  };
  const sharedRuntime = {
    ...(globalThis.space.skills && typeof globalThis.space.skills === "object" ? globalThis.space.skills : {}),
    load: loadAdminSkill
  };

  globalThis.space.admin = adminRuntime;
  globalThis.space.skills = sharedRuntime;

  return {
    admin: adminRuntime,
    skills: sharedRuntime
  };
}
