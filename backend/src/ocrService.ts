import { createWorker } from "tesseract.js";

export type OCRResult = {
  rawText: string;
  suggestedName: string;
  confidence: number;
};

export class OCRService {
  async recognizeCard(imageBase64: string): Promise<OCRResult> {
    const worker = await createWorker("eng");

    try {
      const image = normalizeDataUrl(imageBase64);
      const { data } = await worker.recognize(image);
      const rawText = (data.text ?? "").trim();
      const suggestedName = inferCardName(rawText);
      const confidence = Number((data.confidence ?? 0).toFixed(2));

      return {
        rawText,
        suggestedName,
        confidence
      };
    } finally {
      await worker.terminate();
    }
  }
}

function normalizeDataUrl(value: string): string {
  if (value.startsWith("data:image")) {
    return value;
  }
  return `data:image/jpeg;base64,${value}`;
}

function inferCardName(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  const firstLine = lines[0]
    .replace(/[^A-Za-z0-9' -]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (firstLine.length >= 3) {
    return firstLine;
  }

  return lines.slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
}
