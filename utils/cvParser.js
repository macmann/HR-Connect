const { PDFParse } = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const { getUploadsRoot } = require("./uploadPaths");

// __dirname is .../utils, so repo root is one level up
const repoRoot = path.join(__dirname, "..");

function resolveCvPath(cvPath) {
  if (!cvPath) {
    throw new Error("CV file not found: no CV path provided");
  }

  let p = cvPath.trim();

  // CASE A: Public URL-style path starting with /uploads/...
  // This is NOT a real filesystem root, we must resolve relative to repo root.
  if (p.startsWith("/uploads/")) {
    const rel = p.replace(/^\/+/, ""); // "uploads/cv/xxx.pdf"

    const candidates = [
      path.join(repoRoot, rel),               // <repoRoot>/uploads/...
      path.join(repoRoot, "public", rel),     // <repoRoot>/public/uploads/...
      path.join(getUploadsRoot(), rel.replace(/^uploads\/?/, "")),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    console.error("CV file not found for /uploads path. Tried:", candidates);
    throw new Error("CV file not found at " + candidates.join(" OR "));
  }

  // CASE B: Already a true absolute filesystem path (e.g. from Multer file.path)
  if (path.isAbsolute(p)) {
    if (fs.existsSync(p)) {
      return p;
    }

    // Fallback: older deployments may have used /src/uploads vs /uploads or vice versa
    const fallbackCandidates = [];

    if (p.includes("/src/uploads/")) {
      const alt = p.replace("/src/uploads/", "/uploads/");
      fallbackCandidates.push(alt);
    } else if (p.includes("/uploads/") && !p.includes("/src/uploads/")) {
      const alt = p.replace("/uploads/", "/src/uploads/");
      fallbackCandidates.push(alt);
    }

    for (const candidate of fallbackCandidates) {
      if (fs.existsSync(candidate)) {
        console.warn("CV absolute path fallback used:", candidate);
        return candidate;
      }
    }

    console.error("CV absolute path does not exist, tried:", [p, ...fallbackCandidates]);
    throw new Error("CV file not found at " + [p, ...fallbackCandidates].join(" OR "));
  }

  // CASE C: Relative path (e.g. "uploads/cv/xxx.pdf")
  const candidates = [
    path.join(repoRoot, p),
    path.join(repoRoot, "public", p),
    path.join(getUploadsRoot(), p.replace(/^uploads\/?/, "")),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  console.error("CV file not found. Tried relative paths:", candidates);
  throw new Error("CV file not found at " + candidates.join(" OR "));
}

async function extractTextFromPdf(cvSource) {
  let buffer;

  if (Buffer.isBuffer(cvSource)) {
    buffer = cvSource;
  } else if (cvSource && typeof cvSource === "object" && cvSource.data) {
    buffer = Buffer.isBuffer(cvSource.data)
      ? cvSource.data
      : Buffer.from(cvSource.data, "base64");
  } else {
    const absolutePath = resolveCvPath(cvSource);
    buffer = fs.readFileSync(absolutePath);
  }

  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    if (typeof parser.destroy === "function") {
      await parser.destroy();
    }
  }
}

module.exports = { extractTextFromPdf };
