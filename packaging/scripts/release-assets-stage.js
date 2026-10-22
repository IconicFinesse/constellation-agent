#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { listFiles, readUpdateMetadata, readYamlScalar, serializeUpdateMetadata } = require("./release-metadata");

const FILTERS_PATH = path.join(__dirname, "..", "release-asset-filters.yaml");
const METADATA_SPECS = [
  { fileName: "metadata-latest-windows.yml", platform: "windows", legacyNames: ["latest.yml"] },
  { fileName: "metadata-latest-mac.yml", platform: "macos", legacyNames: ["latest-mac.yml"] },
  { fileName: "metadata-latest-linux.yml", platform: "linux", arch: "x64", legacyNames: ["latest-linux.yml"] },
  { fileName: "metadata-latest-linux-arm64.yml", platform: "linux", arch: "arm64", legacyNames: ["latest-linux-arm64.yml"] }
];
const PUBLIC_EXTENSION_MAP = {
  AppImage: "AppImage",
  dmg: "dmg",
  exe: "exe"
};
const UPDATER_PRIMARY_EXTENSION_MAP = {
  windows: "exe",
  macos: "zip",
  linux: "AppImage"
};

function parseArgs(argv) {
  const assetsDir = argv[0] || "release-assets";
  const outputDir = argv[1] || "release-upload";
  const releaseVersion = String(argv[2] || "").trim();

  if (!releaseVersion) {
    throw new Error(
      "Usage: node packaging/scripts/release-assets-stage.js <release-assets-dir> <output-dir> <release-version>"
    );
  }

  return {
    assetsDir: path.resolve(assetsDir),
    outputDir: path.resolve(outputDir),
    releaseVersion
  };
}

function ensureDirectory(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/gu, "/");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[\\.^$+*?()[\]{}|]/gu, "\\$&");
}

function globPatternToRegExp(pattern) {
  const normalized = toPosixPath(pattern);
  const regexBody = normalized.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp("^" + regexBody + "$", "u");
}

function readReleaseUploadPatterns(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*pattern:\s*(.+?)\s*$/u))
    .filter(Boolean)
    .map((match) => readYamlScalar(match[1]));
}

function inferPlatformArch(relativePath) {
  const artifactDir = toPosixPath(relativePath).split("/")[0];
  const match = artifactDir && artifactDir.match(/^(linux|macos|windows)-(x64|arm64)$/u);
  if (!match) {
    return null;
  }

  return {
    artifactDir,
    platform: match[1],
    arch: match[2]
  };
}

function detectFileKind(fileName) {
  const name = String(fileName || "");

  if (name.endsWith(".zip.blockmap")) {
    return { kind: "zip.blockmap", extension: "zip.blockmap", baseExtension: "zip" };
  }
  if (name.endsWith(".dmg.blockmap")) {
    return { kind: "dmg.blockmap", extension: "dmg.blockmap", baseExtension: "dmg" };
  }
  if (name.endsWith(".exe.blockmap")) {
    return { kind: "exe.blockmap", extension: "exe.blockmap", baseExtension: "exe" };
  }
  if (name.endsWith(".AppImage")) {
    return { kind: "AppImage", extension: "AppImage", baseExtension: "AppImage" };
  }
  if (name.endsWith(".tar.gz")) {
    return { kind: "tar.gz", extension: "tar.gz", baseExtension: "tar.gz" };
  }
  if (name.endsWith(".dmg")) {
    return { kind: "dmg", extension: "dmg", baseExtension: "dmg" };
  }
  if (name.endsWith(".zip")) {
    return { kind: "zip", extension: "zip", baseExtension: "zip" };
  }
  if (name.endsWith(".deb")) {
    return { kind: "deb", extension: "deb", baseExtension: "deb" };
  }
  if (name.endsWith(".exe")) {
    return { kind: "exe", extension: "exe", baseExtension: "exe" };
  }
  if (name.endsWith(".yml")) {
    return { kind: "yml", extension: "yml", baseExtension: "yml" };
  }

  return null;
}

function buildArtifactIndex(rootDir) {
  return listFiles(rootDir)
    .map((filePath) => {
      const relativePath = toPosixPath(path.relative(rootDir, filePath));
      const owner = inferPlatformArch(relativePath);
      const detected = detectFileKind(path.basename(filePath));
      if (!owner || !detected) {
        return null;
      }

      return {
        path: filePath,
        relativePath,
        basename: path.basename(filePath),
        size: fs.statSync(filePath).size,
        artifactDir: owner.artifactDir,
        platform: owner.platform,
        arch: owner.arch,
        kind: detected.kind,
        extension: detected.extension,
        baseExtension: detected.baseExtension
      };
    })
    .filter(Boolean);
}

function createStageContext(outputDir) {
  return {
    outputDir,
    staged: new Map(),
    staleAssetNames: new Set()
  };
}

function stageFile(context, sourcePath, targetName) {
  if (!targetName) {
    throw new Error("Cannot stage " + sourcePath + " without a target name.");
  }

  const existing = context.staged.get(targetName);
  if (existing) {
    if (existing.sourcePath !== sourcePath) {
      throw new Error(
        "Duplicate staged asset name " + targetName + " from " + existing.sourcePath + " and " + sourcePath + "."
      );
    }
    return existing.outputPath;
  }

  const outputPath = path.join(context.outputDir, targetName);
  try {
    fs.linkSync(sourcePath, outputPath);
  } catch (_error) {
    fs.copyFileSync(sourcePath, outputPath);
  }

  context.staged.set(targetName, {
    sourcePath,
    outputPath,
    targetName
  });
  context.staleAssetNames.add(targetName);
  return outputPath;
}

function stageGeneratedFile(context, targetName, contents, sourcePath = "") {
  const outputPath = path.join(context.outputDir, targetName);
  fs.writeFileSync(outputPath, contents, "utf8");
  context.staged.set(targetName, {
    sourcePath,
    outputPath,
    targetName
  });
  context.staleAssetNames.add(targetName);
  return outputPath;
}

function addSourceStaleBasename(context, artifactDir, basename) {
  context.staleAssetNames.add(basename);
  context.staleAssetNames.add(artifactDir + "-" + basename);
}

function addSourceStaleNames(context, record) {
  addSourceStaleBasename(context, record.artifactDir, record.basename);
}

function buildCanonicalAssetName(releaseVersion, platform, arch, baseExtension) {
  if (platform === "macos" && baseExtension === "zip") {
    return "Constellation-Agent-" + releaseVersion + "-" + platform + "-" + arch + "-update.zip";
  }

  const publicExtension = PUBLIC_EXTENSION_MAP[baseExtension];
  if (!publicExtension) {
    throw new Error(
      "No canonical release asset mapping is configured for " + platform + "/" + arch + "/" + baseExtension + "."
    );
  }

  return "Constellation-Agent-" + releaseVersion + "-" + platform + "-" + arch + "." + publicExtension;
}

function createCanonicalMetadataArtifact(record, releaseVersion, metadataEntry) {
  const targetName = buildCanonicalAssetName(releaseVersion, record.platform, record.arch, record.baseExtension);
  return {
    ...metadataEntry,
    url: targetName,
    size: String(record.size)
  };
}

function stagePublicReleaseAssets(releaseVersion, context, artifactIndex) {
  const patterns = readReleaseUploadPatterns(FILTERS_PATH).map((pattern) => ({
    pattern,
    regex: globPatternToRegExp(pattern)
  }));

  artifactIndex.forEach((record) => {
    const filterPath = "release-assets/" + record.relativePath;
    if (!patterns.some((entry) => entry.regex.test(filterPath))) {
      return;
    }

    const targetName = buildCanonicalAssetName(releaseVersion, record.platform, record.arch, record.baseExtension);
    stageFile(context, record.path, targetName);
    addSourceStaleNames(context, record);
    console.log(filterPath + " -> " + targetName);
  });
}

function detectArchHint(value) {
  const text = String(value || "");
  if (/arm64/u.test(text)) {
    return "arm64";
  }
  if (/x64/u.test(text)) {
    return "x64";
  }
  return "";
}

function matchMetadataAsset(platformFiles, metadataFileName, metadataEntry) {
  const requestedUrl = String(metadataEntry.url || "").trim();
  const targetExtensionInfo = detectFileKind(requestedUrl);
  if (!targetExtensionInfo) {
    throw new Error("Could not infer file type for " + requestedUrl + " in " + metadataFileName + ".");
  }

  let candidates = platformFiles.filter((file) => file.baseExtension === targetExtensionInfo.baseExtension);

  const exactNameMatches = candidates.filter((file) => file.basename === requestedUrl);
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0];
  }
  if (exactNameMatches.length > 1) {
    candidates = exactNameMatches;
  }

  const archHint = detectArchHint(requestedUrl);
  if (archHint) {
    const archMatches = candidates.filter((file) => file.arch === archHint);
    if (archMatches.length) {
      candidates = archMatches;
    }
  }

  const targetSize = Number(metadataEntry.size);
  if (Number.isFinite(targetSize) && targetSize > 0) {
    const sizeMatches = candidates.filter((file) => file.size === targetSize);
    if (sizeMatches.length) {
      candidates = sizeMatches;
    }
  }

  if (candidates.length !== 1) {
    throw new Error(
      "Could not match updater asset " + requestedUrl + " from " + metadataFileName + " to one packaged file."
    );
  }

  return candidates[0];
}

function markBlockmapAsStale(context, record, originalUrl) {
  const blockmapPath = record.path + ".blockmap";
  if (!fs.existsSync(blockmapPath)) {
    return;
  }

  addSourceStaleBasename(context, record.artifactDir, path.basename(blockmapPath));
  context.staleAssetNames.add(String(originalUrl || "") + ".blockmap");
}

function stageUpdaterMetadataAssets(rootDir, context, artifactIndex, releaseVersion) {
  METADATA_SPECS.forEach((spec) => {
    const metadataPath = path.join(rootDir, spec.fileName);
    if (!fs.existsSync(metadataPath)) {
      return;
    }

    const metadata = readUpdateMetadata(metadataPath);
    const platformFiles = artifactIndex.filter((record) => {
      if (record.platform !== spec.platform) {
        return false;
      }
      if (record.kind.endsWith(".blockmap")) {
        return false;
      }
      if (spec.arch && record.arch !== spec.arch) {
        return false;
      }
      return true;
    });

    const desiredBaseExtension = UPDATER_PRIMARY_EXTENSION_MAP[spec.platform];
    const rewrittenFiles = [];

    metadata.files.forEach((metadataEntry) => {
      const matched = matchMetadataAsset(platformFiles, spec.fileName, metadataEntry);
      addSourceStaleNames(context, matched);
      if (metadataEntry.url) {
        context.staleAssetNames.add(metadataEntry.url);
      }
      markBlockmapAsStale(context, matched, metadataEntry.url);

      if (matched.baseExtension !== desiredBaseExtension) {
        return;
      }

      const rewrittenEntry = createCanonicalMetadataArtifact(matched, releaseVersion, metadataEntry);
      stageFile(context, matched.path, rewrittenEntry.url);
      rewrittenFiles.push(rewrittenEntry);
      console.log(toPosixPath(path.relative(process.cwd(), matched.path)) + " -> " + rewrittenEntry.url);
    });

    if (!rewrittenFiles.length) {
      throw new Error("No updater payloads were selected for " + spec.fileName + ".");
    }

    const rewrittenMetadata = {
      ...metadata,
      files: rewrittenFiles,
      path: rewrittenFiles[0].url,
      sha512: rewrittenFiles[0].sha512 || ""
    };

    stageGeneratedFile(context, spec.fileName, serializeUpdateMetadata(rewrittenMetadata), metadataPath);
    spec.legacyNames.forEach((legacyName) => {
      context.staleAssetNames.add(legacyName);
    });
  });
}

function writeManifest(context) {
  const manifestPath = path.join(context.outputDir, ".manifest.json");
  const manifest = {
    staleAssetNames: Array.from(context.staleAssetNames).sort(),
    uploadFiles: Array.from(context.staged.values())
      .map((entry) => entry.outputPath)
      .sort()
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(parsed.assetsDir)) {
    throw new Error("Release assets directory does not exist: " + parsed.assetsDir);
  }

  ensureDirectory(parsed.outputDir);

  const artifactIndex = buildArtifactIndex(parsed.assetsDir);
  const context = createStageContext(parsed.outputDir);

  stagePublicReleaseAssets(parsed.releaseVersion, context, artifactIndex);
  stageUpdaterMetadataAssets(parsed.assetsDir, context, artifactIndex, parsed.releaseVersion);

  const manifestPath = writeManifest(context);
  console.log("Wrote release upload manifest to " + manifestPath + ".");
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
