import fs from "node:fs";
import { parseSimpleYaml } from "../../../app/L0/_all/modules/_core/framework/js/yaml-lite.js";
import {
  normalizeEntityId,
  parseGroupConfigProjectPath,
  resolveProjectAbsolutePath
} from "./layout.js";

function createEmptyGroupRecord(groupId) {
  return {
    groupId,
    directIncludedGroups: new Set(),
    directIncludedUsers: new Set(),
    directManagingGroups: new Set(),
    directManagingUsers: new Set(),
    directParentGroups: new Set(),
    includesAllUsers: false,
    managedByAllUsers: false,
    managerUsers: new Set(),
    managesGroups: new Set(),
    memberUsers: new Set(),
    sourcePaths: {
      L0: "",
      L1: ""
    }
  };
}

function createEmptyUserRecord(username) {
  return {
    directGroups: new Set(),
    groups: new Set(),
    managedGroups: new Set(),
    username
  };
}

function ensureGroup(groupRecords, groupId) {
  if (!groupRecords.has(groupId)) {
    groupRecords.set(groupId, createEmptyGroupRecord(groupId));
  }

  return groupRecords.get(groupId);
}

function ensureUser(userRecords, username) {
  if (!userRecords.has(username)) {
    userRecords.set(username, createEmptyUserRecord(username));
  }

  return userRecords.get(username);
}

function readNormalizedList(config, key, projectPath, errors) {
  const rawValue = config[key];
  const values = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
  const output = [];

  for (const item of values) {
    const normalized = normalizeEntityId(item);

    if (!normalized) {
      if (String(item || "").trim()) {
        errors.push({
          message: `Ignored invalid ${key} entry.`,
          projectPath,
          value: String(item)
        });
      }

      continue;
    }

    output.push(normalized);
  }

  return output;
}

function sortStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function hydrateGroupIndexSnapshot(snapshot = {}) {
  const groups =
    snapshot.groups && typeof snapshot.groups === "object" && !Array.isArray(snapshot.groups)
      ? {
          ...snapshot.groups
        }
      : Object.create(null);
  const users =
    snapshot.users && typeof snapshot.users === "object" && !Array.isArray(snapshot.users)
      ? {
          ...snapshot.users
        }
      : Object.create(null);
  const errors = Array.isArray(snapshot.errors) ? [...snapshot.errors] : [];
  const inclusionCycles = Array.isArray(snapshot.inclusionCycles) ? [...snapshot.inclusionCycles] : [];

  function isUserInGroup(username, groupId) {
    const normalizedUsername = normalizeEntityId(username);
    const normalizedGroupId = normalizeEntityId(groupId);

    if (!normalizedGroupId) {
      return false;
    }

    if (normalizedGroupId === "_all") {
      return true;
    }

    const groupRecord = groups[normalizedGroupId];

    if (!groupRecord) {
      return false;
    }

    if (groupRecord.includesAllUsers) {
      return true;
    }

    if (!normalizedUsername) {
      return false;
    }

    return Array.isArray(groupRecord.memberUsers) && groupRecord.memberUsers.includes(normalizedUsername);
  }

  function getOrderedGroupsForUser(username) {
    const normalizedUsername = normalizeEntityId(username);
    const userRecord = normalizedUsername ? users[normalizedUsername] || null : null;
    return userRecord && Array.isArray(userRecord.groups) ? [...userRecord.groups] : [];
  }

  function getManagedGroupsForUser(username) {
    const normalizedUsername = normalizeEntityId(username);
    const userRecord = normalizedUsername ? users[normalizedUsername] || null : null;
    return userRecord && Array.isArray(userRecord.managedGroups) ? [...userRecord.managedGroups] : [];
  }

  return {
    errors,
    getManagedGroupsForUser,
    getOrderedGroupsForUser,
    groups,
    inclusionCycles,
    isUserInGroup,
    users
  };
}

function serializeGroupIndexSnapshot(snapshot = {}) {
  const hydratedSnapshot = hydrateGroupIndexSnapshot(snapshot);

  return {
    errors: [...hydratedSnapshot.errors],
    groups: {
      ...hydratedSnapshot.groups
    },
    inclusionCycles: [...hydratedSnapshot.inclusionCycles],
    users: {
      ...hydratedSnapshot.users
    }
  };
}

function buildGroupIndexSnapshot(context) {
  const groupRecords = new Map();
  const userRecords = new Map();
  const inclusionCycles = [];
  const errors = [];
  const matchedPaths = Array.isArray(context && context.filePaths) ? context.filePaths : [];
  const projectRoot = context && context.projectRoot ? context.projectRoot : "";

  ensureGroup(groupRecords, "_admin");

  for (const projectPath of matchedPaths) {
    const groupConfigInfo = parseGroupConfigProjectPath(projectPath);

    if (!groupConfigInfo || groupConfigInfo.groupId === "_all") {
      continue;
    }

    const groupRecord = ensureGroup(groupRecords, groupConfigInfo.groupId);
    groupRecord.sourcePaths[groupConfigInfo.layer] = projectPath;

    let parsedConfig = {};

    try {
      const absolutePath = resolveProjectAbsolutePath(projectRoot, projectPath, context.runtimeParams);
      parsedConfig = parseSimpleYaml(fs.readFileSync(absolutePath, "utf8"));
    } catch (error) {
      errors.push({
        message: `Failed to parse group.yaml: ${error.message}`,
        projectPath
      });
      continue;
    }

    for (const username of readNormalizedList(parsedConfig, "included_users", projectPath, errors)) {
      groupRecord.directIncludedUsers.add(username);
      ensureUser(userRecords, username);
    }

    for (const childGroupId of readNormalizedList(parsedConfig, "included_groups", projectPath, errors)) {
      if (childGroupId === "_all") {
        groupRecord.includesAllUsers = true;
        continue;
      }

      ensureGroup(groupRecords, childGroupId);
      groupRecord.directIncludedGroups.add(childGroupId);
    }

    for (const username of readNormalizedList(parsedConfig, "managing_users", projectPath, errors)) {
      groupRecord.directManagingUsers.add(username);
      ensureUser(userRecords, username);
    }

    for (const managerGroupId of readNormalizedList(parsedConfig, "managing_groups", projectPath, errors)) {
      if (managerGroupId === "_all") {
        groupRecord.managedByAllUsers = true;
        continue;
      }

      ensureGroup(groupRecords, managerGroupId);
      groupRecord.directManagingGroups.add(managerGroupId);
    }
  }

  for (const groupRecord of groupRecords.values()) {
    for (const childGroupId of groupRecord.directIncludedGroups) {
      ensureGroup(groupRecords, childGroupId).directParentGroups.add(groupRecord.groupId);
    }

    for (const managerGroupId of groupRecord.directManagingGroups) {
      ensureGroup(groupRecords, managerGroupId).managesGroups.add(groupRecord.groupId);
    }
  }

  const adminRecord = ensureGroup(groupRecords, "_admin");
  adminRecord.managesGroups.add("_all");

  const memberUserCache = new Map();
  const managerUserCache = new Map();
  const universalMemberCache = new Map();
  const universalManagerCache = new Map();

  function groupIncludesAllUsers(groupId, stack = []) {
    if (universalMemberCache.has(groupId)) {
      return universalMemberCache.get(groupId);
    }

    if (stack.includes(groupId)) {
      return false;
    }

    const groupRecord = ensureGroup(groupRecords, groupId);
    const nextStack = [...stack, groupId];
    const includesAllUsers =
      groupRecord.includesAllUsers ||
      [...groupRecord.directIncludedGroups].some((childGroupId) =>
        groupIncludesAllUsers(childGroupId, nextStack)
      );

    universalMemberCache.set(groupId, includesAllUsers);
    return includesAllUsers;
  }

  function groupManagersIncludeAllUsers(groupId) {
    if (universalManagerCache.has(groupId)) {
      return universalManagerCache.get(groupId);
    }

    const groupRecord = ensureGroup(groupRecords, groupId);
    const managedByAllUsers =
      groupRecord.managedByAllUsers ||
      [...groupRecord.directManagingGroups].some((managerGroupId) => groupIncludesAllUsers(managerGroupId));

    universalManagerCache.set(groupId, managedByAllUsers);
    return managedByAllUsers;
  }

  function resolveMemberUsers(groupId, stack = []) {
    if (memberUserCache.has(groupId)) {
      return memberUserCache.get(groupId);
    }

    if (stack.includes(groupId)) {
      inclusionCycles.push([...stack, groupId]);
      return new Set();
    }

    const groupRecord = ensureGroup(groupRecords, groupId);
    const users = new Set(groupRecord.directIncludedUsers);
    const nextStack = [...stack, groupId];

    for (const childGroupId of groupRecord.directIncludedGroups) {
      for (const username of resolveMemberUsers(childGroupId, nextStack)) {
        users.add(username);
      }
    }

    memberUserCache.set(groupId, users);
    return users;
  }

  function resolveManagerUsers(groupId) {
    if (managerUserCache.has(groupId)) {
      return managerUserCache.get(groupId);
    }

    const groupRecord = ensureGroup(groupRecords, groupId);
    const users = new Set(groupRecord.directManagingUsers);

    for (const managerGroupId of groupRecord.directManagingGroups) {
      for (const username of resolveMemberUsers(managerGroupId)) {
        users.add(username);
      }
    }

    managerUserCache.set(groupId, users);
    return users;
  }

  for (const groupRecord of groupRecords.values()) {
    groupRecord.memberUsers = resolveMemberUsers(groupRecord.groupId);
    groupRecord.managerUsers = resolveManagerUsers(groupRecord.groupId);
  }

  function isUserInGroup(username, groupId) {
    const normalizedUsername = normalizeEntityId(username);
    const normalizedGroupId = normalizeEntityId(groupId);

    if (!normalizedGroupId) {
      return false;
    }

    if (normalizedGroupId === "_all") {
      return true;
    }

    const groupRecord = groupRecords.get(normalizedGroupId);

    if (!groupRecord) {
      return false;
    }

    if (groupIncludesAllUsers(normalizedGroupId)) {
      return true;
    }

    if (!normalizedUsername) {
      return false;
    }

    return groupRecord.memberUsers.has(normalizedUsername);
  }

  function getOrderedGroupsForUser(username) {
    const normalizedUsername = normalizeEntityId(username);
    const groupIds = new Set();

    for (const groupRecord of groupRecords.values()) {
      if (groupIncludesAllUsers(groupRecord.groupId)) {
        groupIds.add(groupRecord.groupId);
      }
    }

    if (normalizedUsername) {
      for (const groupRecord of groupRecords.values()) {
        if (groupRecord.memberUsers.has(normalizedUsername)) {
          groupIds.add(groupRecord.groupId);
        }
      }
    }

    const remainingGroupIds = [...groupIds].filter((groupId) => groupId !== "_all");
    const indegree = new Map();
    const outgoing = new Map();

    for (const groupId of remainingGroupIds) {
      indegree.set(groupId, 0);
      outgoing.set(groupId, new Set());
    }

    for (const groupId of remainingGroupIds) {
      const groupRecord = groupRecords.get(groupId);

      if (!groupRecord) {
        continue;
      }

      for (const parentGroupId of groupRecord.directParentGroups) {
        if (parentGroupId === "_all" || !indegree.has(parentGroupId)) {
          continue;
        }

        outgoing.get(groupId).add(parentGroupId);
        indegree.set(parentGroupId, Number(indegree.get(parentGroupId) || 0) + 1);
      }
    }

    const orderedGroups = [];
    const queue = [...remainingGroupIds]
      .filter((groupId) => Number(indegree.get(groupId) || 0) === 0)
      .sort((left, right) => left.localeCompare(right));

    while (queue.length > 0) {
      const groupId = queue.shift();
      orderedGroups.push(groupId);

      for (const nextGroupId of sortStrings(outgoing.get(groupId) || [])) {
        const nextDegree = Number(indegree.get(nextGroupId) || 0) - 1;
        indegree.set(nextGroupId, nextDegree);

        if (nextDegree === 0) {
          queue.push(nextGroupId);
          queue.sort((left, right) => left.localeCompare(right));
        }
      }
    }

    const unresolvedGroups = remainingGroupIds
      .filter((groupId) => !orderedGroups.includes(groupId))
      .sort((left, right) => left.localeCompare(right));

    orderedGroups.push(...unresolvedGroups);
    return orderedGroups;
  }

  function getManagedGroupsForUser(username) {
    const normalizedUsername = normalizeEntityId(username);
    const managedGroups = new Set();

    for (const groupRecord of groupRecords.values()) {
      if (groupManagersIncludeAllUsers(groupRecord.groupId)) {
        managedGroups.add(groupRecord.groupId);
      }
    }

    if (normalizedUsername) {
      for (const groupRecord of groupRecords.values()) {
        if (groupRecord.managerUsers.has(normalizedUsername)) {
          managedGroups.add(groupRecord.groupId);
        }
      }
    }

    if (isUserInGroup(normalizedUsername, "_admin")) {
      managedGroups.add("_all");
    }

    return sortStrings(managedGroups);
  }

  for (const groupRecord of groupRecords.values()) {
    for (const username of groupRecord.directIncludedUsers) {
      ensureUser(userRecords, username).directGroups.add(groupRecord.groupId);
    }

    for (const username of groupRecord.memberUsers) {
      ensureUser(userRecords, username).groups.add(groupRecord.groupId);
    }

    for (const username of groupRecord.managerUsers) {
      ensureUser(userRecords, username).managedGroups.add(groupRecord.groupId);
    }
  }

  const groups = Object.create(null);
  const users = Object.create(null);

  for (const groupId of sortStrings(groupRecords.keys())) {
    const groupRecord = groupRecords.get(groupId);

    groups[groupId] = {
      groupId,
      includedGroups: sortStrings(groupRecord.directIncludedGroups),
      includedUsers: sortStrings(groupRecord.directIncludedUsers),
      includesAllUsers: groupIncludesAllUsers(groupRecord.groupId),
      managedByAllUsers: groupManagersIncludeAllUsers(groupRecord.groupId),
      managerUsers: sortStrings(groupRecord.managerUsers),
      managingGroups: sortStrings(groupRecord.directManagingGroups),
      managingUsers: sortStrings(groupRecord.directManagingUsers),
      managesGroups: sortStrings(groupRecord.managesGroups),
      memberUsers: sortStrings(groupRecord.memberUsers),
      parentGroups: sortStrings(groupRecord.directParentGroups),
      sourcePaths: {
        L0: groupRecord.sourcePaths.L0,
        L1: groupRecord.sourcePaths.L1
      }
    };
  }

  for (const username of sortStrings(userRecords.keys())) {
    const userRecord = userRecords.get(username);

    users[username] = {
      directGroups: sortStrings(userRecord.directGroups),
      groups: getOrderedGroupsForUser(username),
      managedGroups: getManagedGroupsForUser(username),
      username
    };
  }

  return hydrateGroupIndexSnapshot({
    errors,
    groups,
    inclusionCycles,
    users
  });
}

export {
  buildGroupIndexSnapshot,
  hydrateGroupIndexSnapshot,
  serializeGroupIndexSnapshot
};
