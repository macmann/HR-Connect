const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");

function resolveCvPath(cvPath) {
  if (!cvPath) {
    throw new Error("No CV path provided");
  }

  let normalized = cvPath.trim();

  // If it's already absolute, just verify it
  if (path.isAbsolute(normalized)) {
    if (fs.existsSync(normalized)) {
      return normalized;
    }
    console.error("CV absolute path does not exist:", normalized);
    throw new Error("CV file not found at " + normalized);
  }

  // Otherwise, treat it as a relative/public path like "/uploads/cv/..."
  if (normalized.startsWith("/")) {
    normalized = normalized.substring(1);
  }

  // __dirname is .../utils
  const rootDir = path.join(__dirname, ".."); // project root (one level up from utils)
  const candidatePaths = [
    path.join(rootDir, normalized),              // e.g. /project/uploads/cv/...
    path.join(rootDir, "public", normalized),    // e.g. /project/public/uploads/cv/...
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  console.error("CV file not found. Tried paths:", candidatePaths);
  throw new Error("CV file not found at " + candidatePaths.join(" OR "));
}

async function extractTextFromPdf(cvPath) {
  const absolutePath = resolveCvPath(cvPath);

  const buffer = fs.readFileSync(absolutePath);
  const result = await pdfParse(buffer);
  return result.text || "";
}

module.exports = { extractTextFromPdf };
