import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDocsDir = path.resolve(scriptDir, "..", "api-docs");
const officialDir = path.join(apiDocsDir, "official");
const officialManifestPath = path.join(officialDir, "manifest.json");

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&rarr;", "→");
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(?:p|li|tr|td|th|dd|dt|h\d)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseTable(tableHtml) {
  const headerHtml = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? "";
  const headers = [...headerHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) =>
    htmlToText(match[1]).toLowerCase()
  );
  const bodyHtml = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  return [...bodyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      htmlToText(cell[1])
    );
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function sectionAt(html, position) {
  let section = null;
  for (const heading of html.slice(0, position).matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)) {
    section = htmlToText(heading[1]);
  }
  return section;
}

function namedBlocks(html) {
  const matches = [...html.matchAll(/<h4\b([^>]*)>([\s\S]*?)<\/h4>/gi)];
  return matches.flatMap((match, index) => {
    const id = match[1].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id) return [];
    const end = matches[index + 1]?.index ?? html.indexOf("</article>", match.index);
    const rawHeading = match[2];
    const name = htmlToText(rawHeading.split(/<span\b/i, 1)[0]);
    const signatureHtml = rawHeading.match(
      /<span\b[^>]*class\s*=\s*["']signature["'][^>]*>([\s\S]*?)<\/span>/i
    )?.[1];
    const returnFromHeading = htmlToText(rawHeading).match(/→\s*\{(.+?)\}/)?.[1] ?? null;
    return [
      {
        id,
        name,
        section: sectionAt(html, match.index),
        signature: signatureHtml ? htmlToText(signatureHtml) : null,
        returnFromHeading,
        html: html.slice(match.index, end >= 0 ? end : html.length),
      },
    ];
  });
}

function parseParameters(blockHtml) {
  const tableHtml = blockHtml.match(/<h5>Parameters:<\/h5>\s*<table\b[^>]*class\s*=\s*["']params["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!tableHtml) return [];
  return parseTable(tableHtml).map((row) => {
    const attributes = row.attributes || "";
    const description = row.description || "";
    return {
      name: row.name,
      type: row.type || "unknown",
      optional: /optional/i.test(`${attributes} ${description}`),
      repeatable: /repeatable/i.test(attributes),
      description: description || null,
    };
  });
}

function parseReturnTypes(blockHtml, headingType) {
  const returnHtml = blockHtml.match(/<h5>Returns:<\/h5>([\s\S]*)/i)?.[1] ?? "";
  const types = unique(
    [...returnHtml.matchAll(/<span\b[^>]*class\s*=\s*["'][^"']*\bparam-type\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map(
      (match) => htmlToText(match[1])
    )
  );
  return types.length > 0 ? types : headingType ? [headingType] : [];
}

function parseDescription(blockHtml) {
  const descriptionHtml = blockHtml.match(
    /<div\b[^>]*class\s*=\s*["'][^"']*\bdescription\b[^"']*\busertext\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  return descriptionHtml ? htmlToText(descriptionHtml) : null;
}

function parseSince(text) {
  return unique([...text.matchAll(/supported since\s+([^)\s<]+)/gi)].map((match) => match[1]));
}

function parseInheritedFrom(blockHtml) {
  const inherited = blockHtml.match(
    /class\s*=\s*["']inherited-from["'][\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i
  )?.[1];
  return inherited ? htmlToText(inherited) : null;
}

function parseExtends(html) {
  const extendsHtml = html.match(
    /<h3\b[^>]*>\s*Extends\s*<\/h3>([\s\S]*?)(?=<h3\b|<\/article>)/i
  )?.[1];
  if (!extendsHtml) return [];
  return unique(
    [...extendsHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => htmlToText(match[1]))
  );
}

function parseClassDescription(html) {
  const match = html.match(
    /<div\b[^>]*class\s*=\s*["'][^"']*\bclass-description\b[^"']*\busertext\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  return match ? htmlToText(match) : null;
}

function parseCreatableTypes(createBlockHtml) {
  if (!createBlockHtml) return [];
  const beforeParameters = createBlockHtml.split("<h5>Parameters:</h5>", 1)[0];
  const tableHtml = beforeParameters.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!tableHtml) return [];
  return parseTable(tableHtml)
    .map((row) => row.type?.replaceAll('"', "").trim())
    .filter(Boolean);
}

export function parseClassPage(page, html) {
  const className = path.basename(page.path, ".html");
  const methods = {};
  const members = {};
  const blocks = namedBlocks(html);
  for (const block of blocks) {
    const description = parseDescription(block.html);
    const entry = {
      anchor: `${page.path}#${block.id}`,
      signature: block.signature,
      parameters: parseParameters(block.html),
      returns: parseReturnTypes(block.html, block.returnFromHeading),
      description,
      supportedSince: parseSince(description ?? ""),
      inheritedFrom: parseInheritedFrom(block.html),
    };
    if (block.section === "Methods" || block.signature) {
      const overloads = methods[block.name] ?? [];
      overloads.push({ ...entry, overload: overloads.length + 1 });
      methods[block.name] = overloads;
    } else if (block.section === "Members") {
      const type = htmlToText(block.html.slice(0, block.html.indexOf("</h4>"))).match(/:\s*(.+)$/)?.[1];
      members[block.name] = { ...entry, type: type || entry.returns[0] || "unknown" };
    }
  }

  return {
    name: className,
    source: { url: page.url, path: page.path, sha256: page.sha256 },
    description: parseClassDescription(html),
    extends: parseExtends(html),
    creatableTypes: className === "SV" ? parseCreatableTypes(blocks.find((block) => block.id === "create")?.html) : [],
    members,
    methods,
  };
}

function summarize(classes) {
  const classList = Object.values(classes);
  const overloadCount = classList.reduce(
    (total, item) => total + Object.values(item.methods).reduce((sum, overloads) => sum + overloads.length, 0),
    0
  );
  const memberCount = classList.reduce((total, item) => total + Object.keys(item.members).length, 0);
  const callbackOverloads = classList.flatMap((item) =>
    Object.entries(item.methods)
      .filter(([, overloads]) => overloads.some((overload) => overload.parameters.some((param) => param.type === "function")))
      .map(([name]) => `${item.name}.${name}`)
  );
  return {
    classCount: classList.length,
    methodNameCount: classList.reduce((total, item) => total + Object.keys(item.methods).length, 0),
    methodOverloadCount: overloadCount,
    memberCount,
    callbackMethodCount: callbackOverloads.length,
  };
}

export async function buildApiManifest({ outputDir = apiDocsDir } = {}) {
  const official = JSON.parse(await readFile(officialManifestPath, "utf8"));
  const classPages = official.pages.filter(
    (page) => page.path.endsWith(".html") && page.path !== "index.html" && !page.path.startsWith("tutorial-")
  );
  const classEntries = await Promise.all(
    classPages.map(async (page) => [page.path, parseClassPage(page, await readFile(path.join(officialDir, page.path), "utf8"))])
  );
  const classes = Object.fromEntries(
    classEntries
      .map(([, item]) => [item.name, item])
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const summary = summarize(classes);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceMirror: {
      source: official.source,
      language: official.language,
      generatedAt: official.generatedAt,
      documentationGeneratedAt: official.documentationGeneratedAt,
      pageCount: official.pages.length,
    },
    summary,
    creatableTypes: classes.SV.creatableTypes,
    classes,
  };
  const inventory = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    summary,
    classes: Object.values(classes).map((item) => ({
      name: item.name,
      extends: item.extends,
      memberCount: Object.keys(item.members).length,
      methodNameCount: Object.keys(item.methods).length,
      methodOverloadCount: Object.values(item.methods).reduce((sum, overloads) => sum + overloads.length, 0),
      callbackMethods: Object.entries(item.methods)
        .filter(([, overloads]) => overloads.some((overload) => overload.parameters.some((param) => param.type === "function")))
        .map(([name]) => name),
    })),
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "api-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outputDir, "api-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  return manifest;
}

// 解析 --output-dir。缺值或空值必须报错,绝不能静默退回默认的 api-docs/ 而污染正式产物。
function parseCliOutputDir(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--output-dir requires a directory value");
      }
      return value;
    }
    if (arg.startsWith("--output-dir=")) {
      const value = arg.slice("--output-dir=".length);
      if (value === "") throw new Error("--output-dir requires a non-empty directory value");
      return value;
    }
  }
  return undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let cliOutputDir;
  try {
    cliOutputDir = parseCliOutputDir(process.argv.slice(2));
  } catch (error) {
    // 属于 CLI 用法错误:非零退出,不落到正式产物目录。
    console.error(`[sv-api] ${error.message}`);
    process.exit(2);
  }
  buildApiManifest(cliOutputDir ? { outputDir: path.resolve(cliOutputDir) } : {})
    .then((manifest) => {
      console.log(
        `[sv-api] parsed ${manifest.summary.classCount} classes, ${manifest.summary.methodOverloadCount} method overloads, and ${manifest.summary.memberCount} members`
      );
    })
    .catch((error) => {
      console.error("[sv-api] parse failed:", error);
      process.exitCode = 1;
    });
}
