const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

async function extractTextFromPdf(filePath) {
  const resolvedPath = path.resolve(filePath);
  const fileBuffer = await fs.promises.readFile(resolvedPath);
  const ext = path.extname(resolvedPath).toLowerCase();

  if (ext === '.pdf') {
    const parsed = await pdfParse(fileBuffer);
    return parsed.text || '';
  }

  return fileBuffer.toString('utf8');
}

module.exports = { extractTextFromPdf };
