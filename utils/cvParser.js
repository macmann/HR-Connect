const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");

function resolveCvPath(cvPath) {
  if (!cvPath) {
    throw new Error("No CV path provided");
  }

  let normalized = cvPath.trim();

  // Example: "/uploads/cv/xxx.pdf" -> "uploads/cv/xxx.pdf"
  if (normalized.startsWith("/")) {
    normalized = normalized.substring(1);
  }

  // __dirname is .../src/utils
  const srcDir = path.join(__dirname, "..");       // /opt/render/project/src
  const rootDir = path.join(srcDir, "..");         // /opt/render/project

  const candidatePaths = [
    // 1) /opt/render/project/src/uploads/...
    path.join(srcDir, normalized),
    // 2) /opt/render/project/src/public/uploads/...
    path.join(srcDir, "public", normalized),
    // 3) /opt/render/project/uploads/...
    path.join(rootDir, normalized),
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
