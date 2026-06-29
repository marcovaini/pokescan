import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { OCRService } from "./ocrService.js";
import { PokeWalletClient } from "./pokeWalletClient.js";
import { TcgClient } from "./tcgClient.js";
const port = Number(process.env.PORT ?? 8787);
const ocr = new OCRService();
const currentDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(currentDir, "../../web");
const server = createServer(async (req, res) => {
    applyCors(res);
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true });
        return;
    }
    if (req.method === "POST" && req.url === "/ocr") {
        try {
            const body = await readJson(req);
            const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
            if (!imageBase64) {
                sendJson(res, 400, { error: "imageBase64 is required" });
                return;
            }
            sendJson(res, 200, await ocr.recognizeCard(imageBase64));
        }
        catch (error) {
            sendJson(res, 500, { error: readError(error, "OCR failed") });
        }
        return;
    }
    if (req.method === "GET" && req.url?.startsWith("/cards/search")) {
        await handleCardSearch(req, res);
        return;
    }
    if (req.method === "GET" && req.url?.startsWith("/tcg/search")) {
        await handleTcgSearch(req, res);
        return;
    }
    if (req.method === "GET" && tryServeStatic(req, res)) {
        return;
    }
    sendJson(res, 404, { error: "Not found" });
});
server.listen(port, () => {
    console.log(`PokemonScan web app listening on http://localhost:${port}`);
});
async function handleCardSearch(req, res) {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const name = url.searchParams.get("name") ?? "";
    if (!name.trim()) {
        sendJson(res, 400, { error: "name is required" });
        return;
    }
    const pokeWalletKey = getHeader(req, "x-pokewallet-api-key") ?? process.env.POKEWALLET_API_KEY ?? "";
    const pokemonTcgKey = getHeader(req, "x-api-key") ?? process.env.POKEMON_TCG_API_KEY ?? "";
    const errors = [];
    if (pokeWalletKey.trim()) {
        try {
            const client = new PokeWalletClient({ apiKey: pokeWalletKey, baseUrl: "https://api.pokewallet.io" });
            const payload = await client.searchByName(name);
            sendJson(res, 200, { provider: "pokewallet", data: normalizeCards(payload, "pokewallet") });
            return;
        }
        catch (error) {
            errors.push(readError(error, "PokeWallet search failed"));
        }
    }
    try {
        const tcg = new TcgClient({ apiKey: pokemonTcgKey, baseUrl: "https://api.pokemontcg.io" });
        const payload = await tcg.searchByName(name);
        sendJson(res, 200, { provider: "pokemontcg", data: normalizeCards(payload, "pokemontcg") });
    }
    catch (error) {
        errors.push(readError(error, "Pokemon TCG search failed"));
        sendJson(res, 502, { error: errors.join("; ") });
    }
}
async function handleTcgSearch(req, res) {
    try {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        const name = url.searchParams.get("name") ?? "";
        const key = getHeader(req, "x-api-key") ?? process.env.POKEMON_TCG_API_KEY ?? "";
        if (!name.trim()) {
            sendJson(res, 400, { error: "name is required" });
            return;
        }
        const tcg = new TcgClient({ apiKey: key, baseUrl: "https://api.pokemontcg.io" });
        sendJson(res, 200, await tcg.searchByName(name));
    }
    catch (error) {
        sendJson(res, 500, { error: readError(error, "TCG search failed") });
    }
}
function normalizeCards(payload, provider) {
    const items = extractItems(payload);
    return items.map((item) => normalizeCard(item, provider));
}
function extractItems(payload) {
    if (Array.isArray(payload)) {
        return payload.filter(isRecord);
    }
    if (!isRecord(payload)) {
        return [];
    }
    for (const key of ["data", "cards", "results", "items"]) {
        const value = payload[key];
        if (Array.isArray(value)) {
            return value.filter(isRecord);
        }
    }
    return [];
}
function normalizeCard(item, provider) {
    const set = firstRecord(item.set, item.expansion, item.series) ?? {};
    const prices = firstRecord(item.prices, item.price, item.market, item.tcgplayer, item.cardmarket) ?? {};
    const images = firstRecord(item.images, item.image, item.assets) ?? {};
    return {
        id: firstString(item.id, item.cardId, item.uuid, item.slug) ?? `${provider}-${firstString(item.name) ?? "card"}`,
        provider,
        name: firstString(item.name, item.cardName, item.title) ?? "Carta sconosciuta",
        supertype: firstString(item.supertype, item.type, item.category) ?? "Pokemon",
        subtypes: firstStringArray(item.subtypes, item.subTypes, item.tags),
        hp: firstString(item.hp, item.health),
        types: firstStringArray(item.types, item.energyTypes, item.elements),
        number: firstString(item.number, item.cardNumber, item.collectorNumber) ?? "n/d",
        rarity: firstString(item.rarity) ?? "n/d",
        artist: firstString(item.artist, item.illustrator) ?? "n/d",
        set: {
            id: firstString(set.id, set.code, set.slug),
            name: firstString(set.name, set.title, item.setName) ?? "Set non riconosciuto"
        },
        images: {
            small: firstString(images.small, images.thumbnail, images.url, item.imageUrl, item.image_url),
            large: firstString(images.large, images.highres, images.url, item.imageUrl, item.image_url)
        },
        prices: normalizePrices(prices),
        attacks: Array.isArray(item.attacks) ? item.attacks : [],
        raw: item
    };
}
function normalizePrices(prices) {
    return {
        market: firstNumber(prices.market, prices.marketPrice, prices.avg, prices.average, prices.trendPrice, prices.price),
        low: firstNumber(prices.low, prices.lowPrice),
        mid: firstNumber(prices.mid, prices.midPrice),
        high: firstNumber(prices.high, prices.highPrice)
    };
}
function firstRecord(...values) {
    return values.find(isRecord) ?? null;
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (typeof value === "number" && Number.isFinite(value))
            return String(value);
    }
    return null;
}
function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
            return Number(value);
    }
    return null;
}
function firstStringArray(...values) {
    for (const value of values) {
        if (Array.isArray(value))
            return value.map(String).filter(Boolean);
        if (typeof value === "string" && value.trim())
            return [value.trim()];
    }
    return [];
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getHeader(req, name) {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
}
function applyCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Api-Key,X-PokeWallet-Api-Key,Authorization");
}
function tryServeStatic(req, res) {
    const requestUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
    const urlPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = urlPath === "/" ? "index.html" : urlPath.slice(1);
    const filePath = normalize(join(webRoot, relativePath));
    if (!filePath.startsWith(webRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        return false;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", getContentType(filePath));
    createReadStream(filePath).pipe(res);
    return true;
}
function getContentType(filePath) {
    switch (extname(filePath)) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        default:
            return "application/octet-stream";
    }
}
function readError(error, fallback) {
    return error instanceof Error ? error.message : fallback;
}
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}
