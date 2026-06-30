import { GoogleGenAI, createPartFromBase64, Type } from "@google/genai";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? "";
const GEMINI_AI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

export type OCRAttack = {
  name: string;
  description: string;
};

export type OCRResult = {
  rawText: string;
  suggestedName: string;
  pokemonName: string;
  confidence: number;
  candidates: string[];
  cardNumber: string;
  series: string;
  setName: string;
  setCode: string;
  cardType: string;
  hp: string;
  attacks: OCRAttack[];
  weakness: string;
  resistance: string;
  retreatCost: string;
  description: string;
};

type GeminiPayload = {
  candidate_names?: unknown;
  pokemon_name?: unknown;
  card_type?: unknown;
  hp?: unknown;
  attacks?: unknown;
  weakness?: unknown;
  resistance?: unknown;
  retreat_cost?: unknown;
  card_number?: unknown;
  series?: unknown;
  set_name?: unknown;
  set_code?: unknown;
  description?: unknown;
  confidence?: unknown;
  notes?: unknown;
};

const GEMINI_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    candidate_names: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "1 to 3 possible Pokemon names ordered by confidence.",
    },
    pokemon_name: {
      type: Type.STRING,
      description: "Most likely Pokemon name.",
      nullable: true,
    },
    card_type: {
      type: Type.STRING,
      description: "Card evolution/type label such as Basic, Stage 1, Stage 2, ex, V, Trainer, Energy.",
      nullable: true,
    },
    hp: { type: Type.STRING, description: "HP shown on the card.", nullable: true },
    attacks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Attack name." },
          description: { type: Type.STRING, description: "Attack effect text and damage." },
        },
        required: ["name", "description"],
      },
      description: "List of attacks with name and description.",
    },
    weakness: { type: Type.STRING, description: "Weakness information if visible.", nullable: true },
    resistance: { type: Type.STRING, description: "Resistance information if visible.", nullable: true },
    retreat_cost: { type: Type.STRING, description: "Retreat cost if visible.", nullable: true },
    card_number: { type: Type.STRING, description: "Collector number such as 56/162 or TG12/TG30.", nullable: true },
    series: { type: Type.STRING, description: "Expansion or series name if visible.", nullable: true },
    set_name: { type: Type.STRING, description: "Set name if visible.", nullable: true },
    set_code: { type: Type.STRING, description: "Set code if visible.", nullable: true },
    description: { type: Type.STRING, description: "Pokemon flavor text or description if visible.", nullable: true },
    confidence: { type: Type.NUMBER, description: "Recognition confidence from 0 to 1." },
    notes: { type: Type.STRING, description: "Notes about unreadable areas or ambiguity.", nullable: true },
  },
  required: ["candidate_names", "pokemon_name", "card_type", "card_number", "series", "confidence"],
} as const;

export class OCRService {
  async recognizeCard(imageBase64: string): Promise<OCRResult> {
    if (!GEMINI_AI) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const { data, mimeType } = decodeImageData(imageBase64);
    const response = await GEMINI_AI.models.generateContent({
      model: GEMINI_MODEL,
      contents: [buildGeminiPrompt(), createPartFromBase64(data, mimeType)],
      config: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA,
        temperature: 0,
        candidateCount: 1,
      },
    });

    const rawText = typeof response.text === "string" ? response.text.trim() : "";
    const payload = parseGeminiPayload(rawText);
    return normalizeGeminiResult(payload, rawText);
  }
}

function buildGeminiPrompt(): string {
  return [
    "Analizza una singola carta Pokemon e restituisci SOLO JSON valido senza markdown.",
    "Devi estrarre esclusivamente i campi necessari per compilare la scheda carta nell'app.",
    "Non inventare nessun dato: se non e leggibile, usa stringa vuota o array vuoto.",
    "Riconosci: tipo carta (Basic, Stage 1, Stage 2, ex, V, Trainer, Energy), nome Pokemon, HP, azioni, debolezza, resistenza, costo di ritirata, numero carta, serie, nome set, codice set, descrizione del Pokemon.",
    "Per le azioni restituisci un array di oggetti con name e description.",
    "Per tipo carta usa il valore piu vicino a quello stampato sulla carta.",
    "candidate_names deve contenere da 1 a 3 possibili nomi ordinati per fiducia.",
    "confidence deve essere un numero tra 0 e 1.",
    "Se il testo descrittivo del Pokemon non e visibile, lascia description vuota.",
    "Se la carta non e un Pokemon, card_type deve riflettere il tipo corretto e gli altri campi Pokemon possono restare vuoti.",
  ].join(" ");
}

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
  const pokemonName = firstNonEmptyString(payload.pokemon_name) ?? candidateNames[0] ?? "";
  const setName = firstNonEmptyString(payload.set_name) ?? firstNonEmptyString(payload.series) ?? "";
  const series = firstNonEmptyString(payload.series) ?? setName;
  const setCode = firstNonEmptyString(payload.set_code) ?? "";
  const cardNumber = normalizeCollectorNumber(firstNonEmptyString(payload.card_number));
  const confidence = normalizeConfidence(payload.confidence);
  const attacks = normalizeAttacks(payload.attacks);
  const cardType = firstNonEmptyString(payload.card_type) ?? "";
  const hp = firstNonEmptyString(payload.hp) ?? "";
  const weakness = firstNonEmptyString(payload.weakness) ?? "";
  const resistance = firstNonEmptyString(payload.resistance) ?? "";
  const retreatCost = firstNonEmptyString(payload.retreat_cost) ?? "";
  const description = firstNonEmptyString(payload.description) ?? "";

  const summaryLines = [
    pokemonName ? `NAME: ${pokemonName}` : "",
    cardType ? `TYPE: ${cardType}` : "",
    hp ? `HP: ${hp}` : "",
    attacks.length ? `ATTACKS: ${attacks.map((attack) => `${attack.name} - ${attack.description}`).join(" | ")}` : "",
    weakness ? `WEAKNESS: ${weakness}` : "",
    resistance ? `RESISTANCE: ${resistance}` : "",
    retreatCost ? `RETREAT: ${retreatCost}` : "",
    cardNumber ? `NUMBER: ${cardNumber}` : "",
    setName ? `SERIES: ${setName}` : "",
    setCode ? `SET_CODE: ${setCode}` : "",
    description ? `DESCRIPTION: ${description}` : "",
  ].filter(Boolean);

  return {
    rawText: summaryLines.join("\n") || rawText,
    suggestedName: pokemonName,
    pokemonName,
    confidence,
    candidates: candidateNames.length ? candidateNames : (pokemonName ? [pokemonName] : []),
    cardNumber,
    series,
    setName,
    setCode,
    cardType,
    hp,
    attacks,
    weakness,
    resistance,
    retreatCost,
    description,
  };
}

function normalizeAttacks(value: unknown): OCRAttack[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): OCRAttack | null => {
      if (!isRecord(item)) return null;
      const name = firstNonEmptyString(item.name) ?? "";
      const description = firstNonEmptyString(item.description) ?? "";
      if (!name && !description) return null;
      return { name, description };
    })
    .filter((item): item is OCRAttack => Boolean(item));
}

function normalizeConfidence(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) {
    return 0;
  }

  const scaled = raw <= 1 ? raw * 100 : raw;
  return Number(scaled.toFixed(2));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

