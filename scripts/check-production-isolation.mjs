import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = await realpath(process.cwd());
const prototypeRoot = await canonicalPath(path.join(root, "ui"));
const testFixtureRoot = await canonicalPath(path.join(root, "tests", "fixtures"));
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
const sourceDirectories = ["src", "app", "pages", "components"];

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

const aliases = await configuredAliases();
const failures = [];
for (const file of await productionFiles()) {
  const source = await readFile(file, "utf8");
  const relativeFile = path.relative(root, file);
  for (const text of bannedText) {
    if (source.includes(text)) failures.push(`${relativeFile} contains ${text}`);
  }

  const specifiers = isSourceFile(file)
    ? path.extname(file).toLowerCase() === ".css"
      ? staticCssSpecifiers(source)
      : staticJavaScriptSpecifiers(source)
    : [];
  for (const specifier of specifiers) {
    if (await restrictedReference(file, specifier, aliases, prototypeRoot)) {
      failures.push(`${relativeFile} references prototype archive ${specifier}`);
    }
    if (await restrictedReference(file, specifier, aliases, testFixtureRoot)) {
      failures.push(`${relativeFile} references test fixture builder ${specifier}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Production isolation failed:\n${[...new Set(failures)].map((failure) => `- ${failure}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Production isolation passed: production sources and inputs have no prototype or test-fixture dependency.");
}
