import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = await realpath(process.cwd());
const checkerFile = await realpath(fileURLToPath(import.meta.url));
const prototypeRoot = await canonicalPath(path.join(root, "ui"));
const testFixtureRoot = await canonicalPath(path.join(root, "tests", "fixtures"));
const memberContextSeed = await canonicalPath(path.join(root, "data", "member-context.json"));
const dashboardFixtureAdapter = await canonicalPath(path.join(root, "src", "features", "coach-dashboard", "fixture-adapter"));
const graphPublicationRoot = await canonicalPath(path.join(root, "src", "graph", "publication"));
const graphCypherRoot = await canonicalPath(path.join(root, "src", "graph", "cypher"));
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".css"]);
const resolutionExtensions = [...sourceExtensions, ".json"];
const bannedText = [
  "support.js",
  ".dc.html",
  "DCLogic",
  "sc-if",
  "sc-for",
  "style-hover",
  "fonts.googleapis.com",
  "ui/uploads",
];
const sourceDirectories = ["src", "app", "pages", "components", "scripts"];

async function canonicalPath(candidate) {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSourceFile(file) {
  return sourceExtensions.has(path.extname(file).toLowerCase());
}

function isRootConfig(file) {
  return /^(?:next|postcss|tailwind|eslint|vitest|playwright)\.config\.|^(?:ts|js)config\.json$/i.test(file);
}

async function existingDirectory(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })) && true;
  } catch {
    return false;
  }
}

async function filesIn(directory, includeFile) {
  if (!(await existingDirectory(directory))) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(target, includeFile);
    if (entry.isFile() && includeFile(target)) return [target];
    return [];
  }));
  return nested.flat();
}

async function productionFiles() {
  const directories = await Promise.all(sourceDirectories.map((directory) => filesIn(path.join(root, directory), isSourceFile)));
  const publicFiles = await filesIn(path.join(root, "public"), () => true);
  const rootEntries = await readdir(root, { withFileTypes: true });
  const rootFiles = rootEntries
    .filter((entry) => entry.isFile() && (isSourceFile(entry.name) || isRootConfig(entry.name)))
    .map((entry) => path.join(root, entry.name));

  return [...new Set([...directories.flat(), ...publicFiles, ...rootFiles])];
}

function removeQueryAndHash(specifier) {
  return specifier.split(/[?#]/, 1)[0];
}

function staticJavaScriptSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:(?:type\s+)?[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function staticRuntimeJavaScriptSpecifiers(source) {
  const typeOnly = new Set();
  for (const pattern of [
    /\bimport\s+type\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\bexport\s+type\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) typeOnly.add(match[1]);
  }
  return staticJavaScriptSpecifiers(source).filter((specifier) => !typeOnly.has(specifier));
}

function staticCssSpecifiers(source) {
  const specifiers = [];
  const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)')/gi;
  const urlPattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)'"`]+))\s*\)/gi;

  for (const match of source.matchAll(importPattern)) specifiers.push(match[1] ?? match[2]);
  for (const match of source.matchAll(urlPattern)) specifiers.push(match[1] ?? match[2] ?? match[3]);
  return specifiers;
}

async function configuredAliases() {
  const aliases = [];
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    const configFile = path.join(root, fileName);
    let config;
    try {
      config = JSON.parse(await readFile(configFile, "utf8"));
    } catch {
      continue;
    }

    const compilerOptions = config.compilerOptions ?? {};
    const baseDirectory = path.resolve(root, compilerOptions.baseUrl ?? ".");
    for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target === "string") aliases.push({ pattern, target: path.resolve(baseDirectory, target) });
      }
    }
  }
  return aliases;
}

function aliasCandidates(specifier, aliases) {
  const candidates = [];
  for (const { pattern, target } of aliases) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (specifier === pattern) candidates.push(target);
      continue;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    candidates.push(target.replace("*", wildcard));
  }
  return candidates;
}

function candidatesForSpecifier(file, specifier, aliases) {
  const cleaned = removeQueryAndHash(specifier);
  if (!cleaned || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(cleaned)) return [];
  if (cleaned.startsWith(".")) return [path.resolve(path.dirname(file), cleaned)];
  if (path.isAbsolute(cleaned)) {
    return isWithin(cleaned, root) ? [cleaned] : [path.resolve(root, "public", `.${cleaned}`)];
  }
  return aliasCandidates(cleaned, aliases);
}

function resolutionCandidates(candidate) {
  const candidates = [candidate];
  if (!path.extname(candidate)) {
    for (const extension of resolutionExtensions) candidates.push(`${candidate}${extension}`);
    for (const extension of resolutionExtensions) candidates.push(path.join(candidate, `index${extension}`));
  }
  return candidates;
}

async function restrictedReference(file, specifier, aliases, restrictedRoot) {
  for (const candidate of candidatesForSpecifier(file, specifier, aliases)) {
    for (const resolvedCandidate of resolutionCandidates(candidate)) {
      if (isWithin(await canonicalPath(resolvedCandidate), restrictedRoot)) return true;
    }
  }
  return false;
}

function isCopilotBoundary(relativeFile) {
  const normalized = relativeFile.split(path.sep).join("/");
  return normalized.startsWith("src/app/api/copilot/")
    || normalized.startsWith("src/server/copilot/")
    || normalized.startsWith("src/agents/copilot/")
    || normalized === "src/agents/copilot-runtime.ts"
    || /^src\/features\/coach-dashboard\/(?:ConnectedCoachDashboard|production-adapter)\.[^.]+$/.test(normalized)
    || /^src\/app\/page\.[^.]+$/.test(normalized);
}

async function isCopilotRestrictedReference(file, specifier, aliases) {
  for (const candidate of candidatesForSpecifier(file, specifier, aliases)) {
    for (const resolvedCandidate of resolutionCandidates(candidate)) {
      const resolved = await canonicalPath(resolvedCandidate);
      if (resolved === memberContextSeed
        || resolved === `${dashboardFixtureAdapter}.js`
        || resolved === `${dashboardFixtureAdapter}.jsx`
        || resolved === `${dashboardFixtureAdapter}.ts`
        || resolved === `${dashboardFixtureAdapter}.tsx`
        || isWithin(resolved, graphPublicationRoot)
        || isWithin(resolved, graphCypherRoot)) return true;
    }
  }
  return false;
}

async function resolvedReferencePaths(file, specifier, aliases) {
  const resolved = [];
  for (const candidate of candidatesForSpecifier(file, specifier, aliases)) {
    for (const resolvedCandidate of resolutionCandidates(candidate)) {
      resolved.push(await canonicalPath(resolvedCandidate));
    }
  }
  return resolved;
}

function isTransitiveCopilotRestriction(resolved) {
  return resolved === memberContextSeed
    || resolved === `${dashboardFixtureAdapter}.js`
    || resolved === `${dashboardFixtureAdapter}.jsx`
    || resolved === `${dashboardFixtureAdapter}.ts`
    || resolved === `${dashboardFixtureAdapter}.tsx`
    || isWithin(resolved, graphPublicationRoot);
}

function containsRawCypher(source) {
  return /\b(?:MATCH|MERGE|CREATE|DETACH\s+DELETE|DELETE|SET)\s+(?:\(|[A-Za-z_$])/m.test(source);
}

const aliases = await configuredAliases();
const failures = [];
const productionFileList = await productionFiles();
const productionFileByCanonicalPath = new Map(await Promise.all(productionFileList.map(async (file) => [await canonicalPath(file), file])));
const specifiersByFile = new Map();
const runtimeSpecifiersByFile = new Map();
for (const file of productionFileList) {
  const source = await readFile(file, "utf8");
  const relativeFile = path.relative(root, file);
  if (await canonicalPath(file) !== checkerFile) {
    for (const text of bannedText) {
      if (source.includes(text)) failures.push(`${relativeFile} contains ${text}`);
    }
  }
  const copilotBoundary = isCopilotBoundary(relativeFile);
  if (copilotBoundary && containsRawCypher(source)) {
    failures.push(`${relativeFile} contains raw Cypher`);
  }

  const specifiers = isSourceFile(file)
    ? path.extname(file).toLowerCase() === ".css"
      ? staticCssSpecifiers(source)
      : staticJavaScriptSpecifiers(source)
    : [];
  specifiersByFile.set(file, specifiers);
  runtimeSpecifiersByFile.set(file, !isSourceFile(file)
    ? []
    : path.extname(file).toLowerCase() === ".css"
      ? specifiers
      : staticRuntimeJavaScriptSpecifiers(source));
  for (const specifier of specifiers) {
    if (await restrictedReference(file, specifier, aliases, prototypeRoot)) {
      failures.push(`${relativeFile} references prototype archive ${specifier}`);
    }
    if (await restrictedReference(file, specifier, aliases, testFixtureRoot)) {
      failures.push(`${relativeFile} references test fixture builder ${specifier}`);
    }
    if (copilotBoundary && await isCopilotRestrictedReference(file, specifier, aliases)) {
      failures.push(`${relativeFile} references Copilot-restricted module ${specifier}`);
    }
  }
}


const reachable = productionFileList.filter((file) => isCopilotBoundary(path.relative(root, file)));
const visited = new Set();
while (reachable.length > 0) {
  const file = reachable.shift();
  const canonicalFile = await canonicalPath(file);
  if (visited.has(canonicalFile)) continue;
  visited.add(canonicalFile);
  for (const specifier of runtimeSpecifiersByFile.get(file) ?? []) {
    for (const resolved of await resolvedReferencePaths(file, specifier, aliases)) {
      if (isTransitiveCopilotRestriction(resolved)) {
        failures.push(`${path.relative(root, file)} references Copilot-restricted module ${specifier}`);
      }
      const dependency = productionFileByCanonicalPath.get(resolved);
      if (dependency && !visited.has(resolved)) reachable.push(dependency);
    }
  }
}

if (failures.length > 0) {
  console.error(`Production isolation failed:\n${[...new Set(failures)].map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Production isolation passed: production sources and connected Copilot boundaries contain no prototype, test-fixture, fixture-Copilot, graph-write, or raw-Cypher dependency.");
}
