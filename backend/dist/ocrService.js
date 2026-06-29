import { createWorker } from "tesseract.js";
export class OCRService {
    async recognizeCard(imageBase64) {
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
        }
        finally {
            await worker.terminate();
        }
    }
}
function normalizeDataUrl(value) {
    if (value.startsWith("data:image")) {
        return value;
    }
    return `data:image/jpeg;base64,${value}`;
}
function inferCardName(text) {
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
