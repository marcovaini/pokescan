import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
export class OCRService {
    async recognizeCard(imageBase64) {
        const worker = await createWorker("eng");
        try {
            const imageBuffer = decodeImage(imageBase64);
            const regions = await buildRegions(imageBuffer);
            await worker.setParameters({
                preserve_interword_spaces: "1",
                tessedit_char_blacklist: "{}[]<>"
            });
            const namePass = await recognizeRegion(worker, regions.name, PSM.SINGLE_LINE);
            const nameAltPass = await recognizeRegion(worker, regions.nameAlt, PSM.SINGLE_BLOCK);
            const fullPass = await recognizeRegion(worker, regions.full, PSM.SPARSE_TEXT);
            const numberPass = await recognizeRegion(worker, regions.number, PSM.SINGLE_LINE);
            const passes = [namePass, nameAltPass, fullPass, numberPass].filter(Boolean);
            const rawText = passes.map((pass) => pass.text).filter(Boolean).join("\n").trim();
            const candidates = inferCardNames(passes.map((pass) => pass.text));
            const suggestedName = candidates[0] ?? "";
            const cardNumber = inferCardNumber(passes.map((pass) => pass.text));
            const confidence = averageConfidence(passes);
            return {
                rawText,
                suggestedName,
                confidence,
                candidates,
                cardNumber
            };
        }
        finally {
            await worker.terminate();
        }
    }
}
async function buildRegions(input) {
    const base = sharp(input).rotate();
    const metadata = await base.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) {
        const fallback = await preprocess(input, { width: 1200, threshold: 150 });
        return { full: fallback, name: fallback, nameAlt: fallback, number: fallback };
    }
    const nameRegion = {
        left: Math.max(0, Math.round(width * 0.08)),
        top: Math.max(0, Math.round(height * 0.05)),
        width: Math.max(1, Math.round(width * 0.72)),
        height: Math.max(1, Math.round(height * 0.12))
    };
    const nameAltRegion = {
        left: Math.max(0, Math.round(width * 0.06)),
        top: Math.max(0, Math.round(height * 0.04)),
        width: Math.max(1, Math.round(width * 0.80)),
        height: Math.max(1, Math.round(height * 0.18))
    };
    const numberRegion = {
        left: Math.max(0, Math.round(width * 0.54)),
        top: Math.max(0, Math.round(height * 0.84)),
        width: Math.max(1, Math.round(width * 0.34)),
        height: Math.max(1, Math.round(height * 0.10))
    };
    const [full, name, nameAlt, number] = await Promise.all([
        preprocess(await base.clone().toBuffer(), { width: 1400, threshold: 150 }),
        preprocess(await base.clone().extract(nameRegion).toBuffer(), { width: 1600, threshold: 165 }),
        preprocess(await base.clone().extract(nameAltRegion).toBuffer(), { width: 1700, threshold: 155 }),
        preprocess(await base.clone().extract(numberRegion).toBuffer(), { width: 1200, threshold: 175 })
    ]);
    return { full, name, nameAlt, number };
}
async function preprocess(input, options) {
    return sharp(input)
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1.1 })
        .resize({ width: options.width, withoutEnlargement: false })
        .threshold(options.threshold)
        .png()
        .toBuffer();
}
async function recognizeRegion(worker, input, psm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(input);
    return {
        text: sanitizeOcrText(data.text ?? ""),
        confidence: Number((data.confidence ?? 0).toFixed(2))
    };
}
function decodeImage(value) {
    if (value.startsWith("data:image")) {
        const [, payload = ""] = value.split(",", 2);
        return Buffer.from(payload, "base64");
    }
    return Buffer.from(value, "base64");
}
function sanitizeOcrText(text) {
    return text
        .replace(/[|]/g, "I")
        .replace(/[��]/g, '"')
        .replace(/[��]/g, "'")
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function inferCardNames(texts) {
    const ranked = new Map();
    for (const text of texts) {
        for (const line of text.split(/\r?\n/)) {
            const candidate = normalizeCandidate(line);
            if (!candidate || isLikelyNoise(candidate)) {
                continue;
            }
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
function normalizeCandidate(line) {
    return line
        .replace(/[^A-Za-z0-9.' -]/g, " ")
        .replace(/\b(?:BASIC|STAGE\s?1|STAGE\s?2|TRAINER|ENERGY|HP)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function isLikelyNoise(candidate) {
    if (candidate.length < 3 || candidate.length > 28) {
        return true;
    }
    const tokens = candidate.split(" ").filter(Boolean);
    if (!tokens.length || tokens.length > 4) {
        return true;
    }
    const letters = (candidate.match(/[A-Za-z]/g) ?? []).length;
    const digits = (candidate.match(/[0-9]/g) ?? []).length;
    if (letters < 2 || digits > letters) {
        return true;
    }
    return /(weakness|resistance|retreat|ability|attacks?|damage|paralyz|discard|coin)/i.test(candidate);
}
function scoreCandidate(candidate) {
    let score = 0;
    const words = candidate.split(" ").filter(Boolean);
    const letters = (candidate.match(/[A-Za-z]/g) ?? []).length;
    score += Math.min(letters, 20) * 2;
    score += Math.max(0, 20 - Math.abs(candidate.length - 9));
    score += words.length === 1 ? 18 : 10;
    if (/^[A-Z][A-Za-z0-9.'-]+(?: [A-Z][A-Za-z0-9.'-]+){0,2}$/.test(candidate)) {
        score += 16;
    }
    if (/ex|gx|vstar|vmax|v-union|radiant|prime|legend/i.test(candidate)) {
        score += 8;
    }
    return score;
}
function inferCardNumber(texts) {
    for (const text of texts) {
        const match = text.match(/\b([A-Z]{0,3}\d{1,3})\s*[\/]\s*([A-Z]?\d{1,3})\b/i);
        if (match) {
            return `${match[1].toUpperCase()}/${match[2].toUpperCase()}`;
        }
    }
    return "";
}
function averageConfidence(passes) {
    if (!passes.length) {
        return 0;
    }
    const total = passes.reduce((sum, pass) => sum + (Number.isFinite(pass.confidence) ? pass.confidence : 0), 0);
    return Number((total / passes.length).toFixed(2));
}
