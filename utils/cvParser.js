const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");

// __dirname is .../utils, so repo root is one level up
const repoRoot = path.join(__dirname, "..");

function resolveCvPath(cvPath) {
  if (!cvPath) {
    throw new Error("No CV path provided");
  }

  let p = cvPath.trim();

  // CASE A: Public URL-style path starting with /uploads/...
  // This is NOT a real filesystem root, we must resolve relative to repo root.
  if (p.startsWith("/uploads/")) {
    const rel = p.replace(/^\/+/, ""); // "uploads/cv/xxx.pdf"

    const candidates = [
      path.join(repoRoot, rel),               // <repoRoot>/uploads/...
      path.join(repoRoot, "public", rel),     // <repoRoot>/public/uploads/...
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
    console.error("CV absolute path does not exist:", p);
    throw new Error("CV file not found at " + p);
  }

  // CASE C: Relative path (e.g. "uploads/cv/xxx.pdf")
  const candidates = [
    path.join(repoRoot, p),
    path.join(repoRoot, "public", p),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  console.error("CV file not found. Tried relative paths:", candidates);
  throw new Error("CV file not found at " + candidates.join(" OR "));
}

async function extractTextFromPdf(cvPath) {
  const absolutePath = resolveCvPath(cvPath);

  const buffer = fs.readFileSync(absolutePath);
  const result = await pdfParse(buffer);
  return result.text || "";
}

module.exports = { extractTextFromPdf };
