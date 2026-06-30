import sharp from "sharp";
import { GoogleGenAI, createPartFromBase64, Type } from "@google/genai";
import { createWorker, PSM } from "tesseract.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? "";
const GEMINI_AI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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
    if (GEMINI_AI) {
      try {
        const gemini = await recognizeWithGemini(imageBase64);
        if (gemini) {
          return gemini;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gemini failed";
        console.warn(`Gemini recognition failed: ${message}`);
      }
    }

    return recognizeWithTesseract(imageBase64);
  }
}

async function recognizeWithGemini(imageBase64: string): Promise<OCRResult | null> {
  const { data, mimeType } = decodeImageData(imageBase64);
  if (!data) {
    return null;
  }

  const response = await GEMINI_AI!.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      buildGeminiPrompt(),
      createPartFromBase64(data, mimeType),
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_SCHEMA,
      temperature: 0,
      candidateCount: 1,
    },
  });

  const rawText = typeof response.text === "string" ? response.text.trim() : "";
  const parsed = parseGeminiPayload(rawText);
  return normalizeGeminiResult(parsed, rawText);
}

function buildGeminiPrompt(): string {
  return [
    "Analizza una carta Pokemon e restituisci SOLO JSON valido senza markdown.",
    "Obiettivo: identificare nome carta, set e collector number.",
    "Se il numero carta o il set non sono visibili, usa stringa vuota.",
    "Non inventare dati: se un campo non e leggibile, lascialo vuoto.",
    "Rispondi con queste chiavi: candidate_names, name, set_name, set_code, collector_number, confidence, hp, types, subtypes, rarity, artist, notes.",
    "candidate_names deve contenere da 1 a 3 possibili nomi ordinati per fiducia.",
    "confidence deve essere un numero tra 0 e 1.",
  ].join(" ");
}

type GeminiPayload = {
  candidate_names?: unknown;
  name?: unknown;
  set_name?: unknown;
  set_code?: unknown;
  collector_number?: unknown;
  confidence?: unknown;
  hp?: unknown;
  types?: unknown;
  subtypes?: unknown;
  rarity?: unknown;
  artist?: unknown;
  notes?: unknown;
};

const GEMINI_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    candidate_names: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Ordered candidate card names from most likely to least likely.",
    },
    name: { type: Type.STRING, description: "Most likely card name." },
    set_name: { type: Type.STRING, description: "Card set name if visible." },
    set_code: { type: Type.STRING, description: "Card set code if visible.", nullable: true },
    collector_number: { type: Type.STRING, description: "Collector number such as 56/162 or TG12/TG30." },
    confidence: { type: Type.NUMBER, description: "Recognition confidence from 0 to 1." },
    hp: { type: Type.STRING, description: "HP value if visible.", nullable: true },
    types: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Pokemon types." },
    subtypes: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Subtypes or stage labels." },
    rarity: { type: Type.STRING, description: "Rarity if visible.", nullable: true },
    artist: { type: Type.STRING, description: "Illustrator/artist if visible.", nullable: true },
    notes: { type: Type.STRING, description: "Short notes about unreadable or ambiguous areas.", nullable: true },
  },
  required: ["candidate_names", "name", "set_name", "collector_number", "confidence"],
} as const;

function parseGeminiPayload(rawText: string): GeminiPayload {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const jsonText = extractJsonObject(cleaned);
  return JSON.parse(jsonText) as GeminiPayload;
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain JSON");
  }
  return value.slice(start, end + 1);
}

function normalizeGeminiResult(payload: GeminiPayload, rawText: string): OCRResult {
  const candidateNames = normalizeStringArray(payload.candidate_names);
  const primaryName = firstNonEmptyString(payload.name) ?? candidateNames[0] ?? "";
  const cardNumber = normalizeCollectorNumber(firstNonEmptyString(payload.collector_number));
  const confidenceRaw = typeof payload.confidence === "number" ? payload.confidence : Number(payload.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Number((confidenceRaw <= 1 ? confidenceRaw * 100 : confidenceRaw).toFixed(2))
    : 0;

  const summaryLines = [
    primaryName ? `NAME: ${primaryName}` : "",
    firstNonEmptyString(payload.set_name) ? `SET: ${firstNonEmptyString(payload.set_name)}` : "",
    cardNumber ? `NUMBER: ${cardNumber}` : "",
    firstNonEmptyString(payload.set_code) ? `SET_CODE: ${firstNonEmptyString(payload.set_code)}` : "",
    firstNonEmptyString(payload.hp) ? `HP: ${firstNonEmptyString(payload.hp)}` : "",
    normalizeStringArray(payload.types).length ? `TYPES: ${normalizeStringArray(payload.types).join(", ")}` : "",
    normalizeStringArray(payload.subtypes).length ? `SUBTYPES: ${normalizeStringArray(payload.subtypes).join(", ")}` : "",
    firstNonEmptyString(payload.rarity) ? `RARITY: ${firstNonEmptyString(payload.rarity)}` : "",
    firstNonEmptyString(payload.artist) ? `ARTIST: ${firstNonEmptyString(payload.artist)}` : "",
  ].filter(Boolean);

  return {
    rawText: summaryLines.join("\n") || rawText,
    suggestedName: primaryName,
    confidence,
    candidates: candidateNames.length ? candidateNames : (primaryName ? [primaryName] : []),
    cardNumber,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => firstNonEmptyString(item) ?? "").filter(Boolean);
}

function firstNonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeCollectorNumber(value: string | null): string {
  if (!value) return "";
  return value.replace(/\s+/g, "").toUpperCase().replace(/[^A-Z0-9/]+/g, "");
}

function decodeImageData(value: string): { data: string; mimeType: string } {
  if (value.startsWith("data:image")) {
    const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
    const [, payload = ""] = value.split(",", 2);
    return { mimeType: "image/png", data: payload };
  }
  return { mimeType: "image/png", data: value };
}

async function recognizeWithTesseract(imageBase64: string): Promise<OCRResult> {
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



