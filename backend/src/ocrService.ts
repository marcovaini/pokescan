import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";

export type OCRResult = {
  rawText: string;
  suggestedName: string;
  confidence: number;
  candidates: string[];
  cardNumber: string;
};

type OCRPass = {
  text: string;
  confidence: number;
};

type OCRRegions = {
  name: Buffer;
  nameWide: Buffer;
  number: Buffer;
  numberWide: Buffer;
};

export class OCRService {
  async recognizeCard(imageBase64: string): Promise<OCRResult> {
    const worker = await createWorker("eng");

    try {
      const imageBuffer = decodeImage(imageBase64);
      const regions = await buildRegions(imageBuffer);

      const namePass = await recognizeName(worker, regions.name, PSM.SINGLE_LINE);
      const nameWidePass = await recognizeName(worker, regions.nameWide, PSM.SINGLE_BLOCK);
      const numberPass = await recognizeNumber(worker, regions.number, PSM.SINGLE_LINE);
      const numberWidePass = await recognizeNumber(worker, regions.numberWide, PSM.SINGLE_LINE);

      const candidates = inferCardNames([namePass.text, nameWidePass.text]);
      const suggestedName = candidates[0] ?? "";
      const cardNumber = inferCardNumber([numberPass.text, numberWidePass.text]);
      const confidence = weightedConfidence([
        { pass: namePass, weight: 0.4 },
        { pass: nameWidePass, weight: 0.25 },
        { pass: numberPass, weight: 0.25 },
        { pass: numberWidePass, weight: 0.1 }
      ]);
      const rawText = [
        suggestedName ? `NAME: ${suggestedName}` : "",
        cardNumber ? `NUMBER: ${cardNumber}` : "",
        namePass.text ? `NAME_RAW: ${namePass.text}` : "",
        nameWidePass.text ? `NAME_WIDE_RAW: ${nameWidePass.text}` : "",
        numberPass.text ? `NUMBER_RAW: ${numberPass.text}` : "",
        numberWidePass.text ? `NUMBER_WIDE_RAW: ${numberWidePass.text}` : ""
      ].filter(Boolean).join("\n");

      return {
        rawText,
        suggestedName,
        confidence,
        candidates,
        cardNumber
      };
    } finally {
      await worker.terminate();
    }
  }
}

async function buildRegions(input: Buffer): Promise<OCRRegions> {
  const base = sharp(input).rotate();
  const metadata = await base.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (!width || !height) {
    const fallback = await preprocess(input, { width: 2400, threshold: 156 });
    return {
      name: fallback,
      nameWide: fallback,
      number: fallback,
      numberWide: fallback
    };
  }

  const name = {
    left: Math.max(0, Math.round(width * 0.10)),
    top: Math.max(0, Math.round(height * 0.045)),
    width: Math.max(1, Math.round(width * 0.60)),
    height: Math.max(1, Math.round(height * 0.09))
  };

  const nameWide = {
    left: Math.max(0, Math.round(width * 0.07)),
    top: Math.max(0, Math.round(height * 0.035)),
    width: Math.max(1, Math.round(width * 0.72)),
    height: Math.max(1, Math.round(height * 0.12))
  };

  const number = {
    left: Math.max(0, Math.round(width * 0.10)),
    top: Math.max(0, Math.round(height * 0.885)),
    width: Math.max(1, Math.round(width * 0.34)),
    height: Math.max(1, Math.round(height * 0.055))
  };

  const numberWide = {
    left: Math.max(0, Math.round(width * 0.08)),
    top: Math.max(0, Math.round(height * 0.86)),
    width: Math.max(1, Math.round(width * 0.52)),
    height: Math.max(1, Math.round(height * 0.09))
  };

  const [nameBuffer, nameWideBuffer, numberBuffer, numberWideBuffer] = await Promise.all([
    preprocess(await base.clone().extract(name).toBuffer(), { width: 3200, threshold: 160 }),
    preprocess(await base.clone().extract(nameWide).toBuffer(), { width: 3400, threshold: 154 }),
    preprocess(await base.clone().extract(number).toBuffer(), { width: 2600, threshold: 172 }),
    preprocess(await base.clone().extract(numberWide).toBuffer(), { width: 2800, threshold: 168 })
  ]);

  return {
    name: nameBuffer,
    nameWide: nameWideBuffer,
    number: numberBuffer,
    numberWide: numberWideBuffer
  };
}

async function preprocess(input: Buffer, options: { width: number; threshold: number }): Promise<Buffer> {
  return sharp(input)
    .grayscale()
    .normalize()
    .modulate({ brightness: 1.08, saturation: 0 })
    .sharpen({ sigma: 1.2 })
    .resize({ width: options.width, withoutEnlargement: false })
    .threshold(options.threshold)
    .png()
    .toBuffer();
}

async function recognizeName(worker: Awaited<ReturnType<typeof createWorker>>, input: Buffer, psm: PSM): Promise<OCRPass> {
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "1",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-' "
  });

  const { data } = await worker.recognize(input);
  return {
    text: sanitizeNameText(data.text ?? ""),
    confidence: Number((data.confidence ?? 0).toFixed(2))
  };
}

async function recognizeNumber(worker: Awaited<ReturnType<typeof createWorker>>, input: Buffer, psm: PSM): Promise<OCRPass> {
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "0",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/"
  });

  const { data } = await worker.recognize(input);
  return {
    text: sanitizeNumberText(data.text ?? ""),
    confidence: Number((data.confidence ?? 0).toFixed(2))
  };
}

function decodeImage(value: string): Buffer {
  if (value.startsWith("data:image")) {
    const [, payload = ""] = value.split(",", 2);
    return Buffer.from(payload, "base64");
  }
  return Buffer.from(value, "base64");
}

function sanitizeNameText(text: string): string {
  return text
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\b(?:BASIC|STAGE ?1|STAGE ?2|TRAINER|ENERGY|HP)\b/gi, " ")
    .replace(/[^A-Za-z0-9.' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeNumberText(text: string): string {
  return text
    .replace(/[^A-Za-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferCardNames(texts: string[]): string[] {
  const ranked = new Map<string, number>();

  for (const text of texts) {
    const lines = text
      .split(/\r?\n/)
      .flatMap((line) => splitNameCandidates(line))
      .map(normalizeCandidate)
      .filter((candidate) => candidate && !isLikelyNoise(candidate));

    for (const candidate of lines) {
      const score = scoreCandidate(candidate);
      const current = ranked.get(candidate) ?? 0;
      if (score > current) {
        ranked.set(candidate, score);
      }
    }
  }

  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([candidate]) => candidate)
    .slice(0, 5);
}

function splitNameCandidates(line: string): string[] {
  const clean = sanitizeNameText(line);
  if (!clean) {
    return [];
  }

  return [clean]
    .concat(clean.split(/\s{2,}/g))
    .concat(clean.split(/(?<=\D)(?=\d)|(?<=\d)(?=\D)/g).length > 3 ? [] : []);
}

function normalizeCandidate(line: string): string {
  return line
    .replace(/\b(?:Pokemon|Pok mon)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyNoise(candidate: string): boolean {
  if (candidate.length < 3 || candidate.length > 24) {
    return true;
  }

  const words = candidate.split(" ").filter(Boolean);
  if (!words.length || words.length > 3) {
    return true;
  }

  const letters = (candidate.match(/[A-Za-z]/g) ?? []).length;
  const digits = (candidate.match(/[0-9]/g) ?? []).length;

  if (letters < 3 || digits > 2) {
    return true;
  }

  return /(weakness|resistance|retreat|damage|coin|attack|discard)/i.test(candidate);
}

function scoreCandidate(candidate: string): number {
  let score = 0;
  const words = candidate.split(" ").filter(Boolean);
  const letters = (candidate.match(/[A-Za-z]/g) ?? []).length;

  score += Math.min(letters, 18) * 3;
  score += Math.max(0, 18 - Math.abs(candidate.length - 10));
  score += words.length === 1 ? 14 : 8;
  if (/^[A-Z][A-Za-z0-9.'-]+(?: [A-Z][A-Za-z0-9.'-]+){0,1}$/.test(candidate)) {
    score += 20;
  }
  if (/ex|gx|v|vstar|vmax|radiant|prime|break/i.test(candidate)) {
    score += 6;
  }

  return score;
}

function inferCardNumber(texts: string[]): string {
  for (const text of texts) {
    const compact = text.replace(/\s+/g, "");
    const exact = compact.match(/\b([A-Z]{0,3}\d{1,3})\/([A-Z]{0,3}\d{1,3})\b/i);
    if (exact) {
      return `${exact[1].toUpperCase()}/${exact[2].toUpperCase()}`;
    }

    const loose = compact.match(/\b([A-Z]{0,3}\d{1,3})[Il]?\/([A-Z]{0,3}\d{1,3})\b/i);
    if (loose) {
      return `${loose[1].toUpperCase()}/${loose[2].toUpperCase()}`;
    }
  }

  return "";
}

function weightedConfidence(entries: Array<{ pass: OCRPass; weight: number }>): number {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!totalWeight) {
    return 0;
  }

  const total = entries.reduce((sum, entry) => sum + (Number.isFinite(entry.pass.confidence) ? entry.pass.confidence * entry.weight : 0), 0);
  return Number((total / totalWeight).toFixed(2));
}
