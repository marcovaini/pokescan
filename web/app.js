const DB_NAME = "PokemonScanWeb";
const DB_VERSION = 1;
const DEFAULT_SETTINGS = {
  backendUrl: window.location.origin,
  pokeWalletApiKey: "",
  tcgApiKey: "",
  deckSize: 60,
};

const state = {
  db: null,
  stream: null,
  cards: [],
  decks: [],
  settings: { ...DEFAULT_SETTINGS },
  selectedCardId: null,
};

const els = {
  views: document.querySelectorAll(".view"),
  tabs: document.querySelectorAll(".tab"),
  camera: document.querySelector("#camera"),
  cameraGuide: document.querySelector(".camera-guide"),
  canvas: document.querySelector("#capture-canvas"),
  startCamera: document.querySelector("#start-camera"),
  captureCard: document.querySelector("#capture-card"),
  scanStatus: document.querySelector("#scan-status"),
  scanResult: document.querySelector("#scan-result"),
  archiveList: document.querySelector("#archive-list"),
  archiveSearch: document.querySelector("#archive-search"),
  detailContent: document.querySelector("#detail-content"),
  backToArchive: document.querySelector("#back-to-archive"),
  deckRecommendation: document.querySelector("#deck-recommendation"),
  savedDecks: document.querySelector("#saved-decks"),
  saveDeck: document.querySelector("#save-deck"),
  saveSettings: document.querySelector("#save-settings"),
  backendUrl: document.querySelector("#backend-url"),
  pokeWalletKey: document.querySelector("#pokewallet-key"),
  tcgKey: document.querySelector("#tcg-key"),
  deckSize: document.querySelector("#deck-size"),
  cardCount: document.querySelector("#card-count"),
  deckCount: document.querySelector("#deck-count"),
};

await boot();

async function boot() {
  state.db = await openDb();
  state.settings = await loadSettings();
  await refreshCollections();
  bindEvents();
  renderAll();
}

function bindEvents() {
  els.tabs.forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
  els.startCamera.addEventListener("click", startCamera);
  els.captureCard.addEventListener("click", captureAndRecognize);
  els.archiveSearch.addEventListener("input", renderArchive);
  els.backToArchive.addEventListener("click", () => showView("archive"));
  els.saveDeck.addEventListener("click", saveRecommendedDeck);
  els.saveSettings.addEventListener("click", saveSettingsFromForm);
}

function showView(name) {
  els.views.forEach((view) => view.classList.remove("is-active"));
  els.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === name));
  const target = document.querySelector(`#view-${name}`);
  if (target) target.classList.add("is-active");
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Il browser non espone la fotocamera. Usa Chrome, Edge o Firefox su http://localhost.");
    return;
  }

  try {
    stopCamera();
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1920 } },
      audio: false,
    });
    els.camera.srcObject = state.stream;
    setStatus("Camera attiva. Inquadra la carta e scatta.");
  } catch (error) {
    setStatus(`Camera non disponibile: ${readError(error)}`);
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
}

async function captureAndRecognize() {
  if (!state.stream) {
    await startCamera();
    if (!state.stream) return;
  }

  const imageDataUrl = captureFrame();
  setStatus("OCR in corso...");

  try {
    const ocr = await recognize(imageDataUrl);
    const recognized = ocr.suggestedName || ocr.candidates?.[0] || "nome non sicuro";
    setStatus(`OCR completato: ${recognized}`);

    let tcgCard = null;
    let tcgError = "";
    const queries = buildSearchQueries(ocr);

    if (queries.length) {
      try {
        tcgCard = await searchCardCandidates(queries, ocr);
      } catch (error) {
        tcgError = readError(error);
      }
    }

    const stored = createStoredCard({ imageDataUrl, ocr, tcgCard });
    await put("cards", stored);
    await refreshCollections();
    renderAll();
    renderScanResult(stored, ocr, tcgCard, tcgError);
    state.selectedCardId = stored.id;

    if (tcgError) {
      setStatus(`Carta salvata. Dati provider non disponibili: ${tcgError}`);
    } else if (!tcgCard) {
      setStatus("Carta salvata. OCR completato ma nessun match affidabile trovato.");
    } else {
      setStatus("Carta salvata nell'archivio locale.");
    }
  } catch (error) {
    setStatus(`Scansione fallita: ${readError(error)}`);
  }
}

function captureFrame() {
  const video = els.camera;
  const canvas = els.canvas;
  const videoWidth = video.videoWidth || 900;
  const videoHeight = video.videoHeight || 1200;
  const region = getGuideCaptureRegion(video, els.cameraGuide, videoWidth, videoHeight);

  canvas.width = region.sw;
  canvas.height = region.sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, region.sw, region.sh);
  return canvas.toDataURL("image/jpeg", 0.95);
}

function getGuideCaptureRegion(video, guide, sourceWidth, sourceHeight) {
  if (!guide) {
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight };
  }

  const videoRect = video.getBoundingClientRect();
  const guideRect = guide.getBoundingClientRect();
  const scale = Math.max(sourceWidth / videoRect.width, sourceHeight / videoRect.height);

  const cropWidth = videoRect.width * scale;
  const cropHeight = videoRect.height * scale;
  const offsetX = Math.max(0, (cropWidth - sourceWidth) / 2);
  const offsetY = Math.max(0, (cropHeight - sourceHeight) / 2);

  const left = Math.max(0, (guideRect.left - videoRect.left) * scale - offsetX);
  const top = Math.max(0, (guideRect.top - videoRect.top) * scale - offsetY);
  const width = Math.min(sourceWidth - left, guideRect.width * scale);
  const height = Math.min(sourceHeight - top, guideRect.height * scale);

  return {
    sx: Math.max(0, Math.round(left)),
    sy: Math.max(0, Math.round(top)),
    sw: Math.max(1, Math.round(width)),
    sh: Math.max(1, Math.round(height))
  };
}

async function recognize(imageDataUrl) {
  const response = await fetch(`${trimSlash(state.settings.backendUrl)}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: imageDataUrl }),
  });
  if (!response.ok) throw new Error(`backend OCR ${response.status}`);
  return response.json();
}

async function searchCards(name) {
  const headers = {};
  if (state.settings.pokeWalletApiKey) headers["X-PokeWallet-API-Key"] = state.settings.pokeWalletApiKey;
  if (state.settings.tcgApiKey) headers["X-Api-Key"] = state.settings.tcgApiKey;
  const response = await fetch(`${trimSlash(state.settings.backendUrl)}/cards/search?name=${encodeURIComponent(name)}`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Card search ${response.status}`);
  return payload.data || [];
}

async function searchCardCandidates(queries, ocr) {
  let lastError = null;

  for (const query of queries) {
    try {
      const cards = await searchCards(query);
      const best = selectBestCard(cards, ocr);
      if (best) return best;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}

function buildSearchQueries(ocr) {
  const names = [ocr.suggestedName, ...(ocr.candidates || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const cardNumber = String(ocr.cardNumber || "").trim();
  const queries = [];

  names.forEach((name) => {
    if (cardNumber) queries.push(`${name} ${cardNumber}`);
    queries.push(name);
  });

  if (cardNumber) queries.push(cardNumber);
  return uniqueStrings(queries);
}

function selectBestCard(cards, ocr) {
  if (!cards.length) return null;

  const names = [ocr.suggestedName, ...(ocr.candidates || [])].map(normalizeText).filter(Boolean);
  const number = normalizeCardNumber(ocr.cardNumber);
  let best = null;
  let bestScore = -1;

  for (const card of cards) {
    const cardName = normalizeText(card.name);
    const cardNumber = normalizeCardNumber(card.number);
    let score = 0;

    if (names[0] && cardName === names[0]) score += 120;
    if (names.includes(cardName)) score += 70;
    if (names.some((name) => name && (cardName.includes(name) || name.includes(cardName)))) score += 30;
    if (number && cardNumber === number) score += 140;
    if (card.images?.large || card.images?.small) score += 5;
    if (card.prices?.market != null) score += 5;

    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }

  return bestScore >= 40 ? best : null;
}

function createStoredCard({ imageDataUrl, ocr, tcgCard }) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return {
    id,
    tcgId: tcgCard?.id || id,
    name: tcgCard?.name || ocr.suggestedName || ocr.candidates?.[0] || "Carta sconosciuta",
    setName: tcgCard?.set?.name || "Set non riconosciuto",
    number: tcgCard?.number || ocr.cardNumber || "n/d",
    rarity: tcgCard?.rarity || "n/d",
    supertype: tcgCard?.supertype || "Pokemon",
    subtypes: tcgCard?.subtypes || [],
    hp: tcgCard?.hp ? Number.parseInt(tcgCard.hp, 10) || null : null,
    types: tcgCard?.types || [],
    artist: tcgCard?.artist || "n/d",
    imageUrl: tcgCard?.images?.large || tcgCard?.images?.small || "",
    localImage: imageDataUrl,
    price: extractPrice(tcgCard),
    raw: tcgCard || {},
    scanText: ocr.rawText || "",
    ocrCandidates: ocr.candidates || [],
    ocrCardNumber: ocr.cardNumber || "",
    createdAt: Date.now(),
  };
}

function renderAll() {
  renderCounters();
  renderSettings();
  renderArchive();
  renderDecks();
}

function renderCounters() {
  els.cardCount.textContent = `${state.cards.length} carte`;
  els.deckCount.textContent = `${state.decks.length} mazzi`;
}

function renderSettings() {
  els.backendUrl.value = state.settings.backendUrl;
  els.pokeWalletKey.value = state.settings.pokeWalletApiKey || "";
  els.tcgKey.value = state.settings.tcgApiKey;
  els.deckSize.value = String(state.settings.deckSize);
}

function renderArchive() {
  const term = normalizeText(els.archiveSearch.value || "");
  const cards = term
    ? state.cards.filter((card) => normalizeText(`${card.name} ${card.setName} ${card.rarity} ${card.types.join(" ")}`).includes(term))
    : state.cards;

  if (!cards.length) {
    els.archiveList.innerHTML = emptyHtml("Nessuna carta archiviata", "Scansiona una carta per popolare il database locale.");
    return;
  }

  els.archiveList.innerHTML = cards.map((card) => `
    <article class="card-item">
      <img src="${escapeAttr(card.imageUrl || card.localImage)}" alt="${escapeAttr(card.name)}" />
      <div class="card-body">
        <h3>${escapeHtml(card.name)}</h3>
        <span class="meta">${escapeHtml(card.setName)} - #${escapeHtml(card.number)} - ${escapeHtml(card.rarity)}</span>
        <span class="price">${formatPrice(card.price)}</span>
        <div class="inline-actions">
          <button data-open-card="${card.id}">Dettaglio</button>
          <button data-delete-card="${card.id}">Elimina</button>
        </div>
      </div>
    </article>
  `).join("");

  els.archiveList.querySelectorAll("[data-open-card]").forEach((button) => button.addEventListener("click", () => openDetail(button.dataset.openCard)));
  els.archiveList.querySelectorAll("[data-delete-card]").forEach((button) => button.addEventListener("click", () => deleteCard(button.dataset.deleteCard)));
}

function openDetail(cardId) {
  const card = state.cards.find((item) => item.id === cardId);
  if (!card) return;
  state.selectedCardId = cardId;
  const attacks = card.raw?.attacks?.map((attack) => `<li><strong>${escapeHtml(attack.name)}</strong> ${escapeHtml(attack.damage || "")} ${escapeHtml(attack.text || "")}</li>`).join("") || "<li>n/d</li>";
  els.detailContent.innerHTML = `
    <img src="${escapeAttr(card.imageUrl || card.localImage)}" alt="${escapeAttr(card.name)}" />
    <article class="detail-panel">
      <p class="eyebrow">${escapeHtml(card.supertype)}</p>
      <h2>${escapeHtml(card.name)}</h2>
      <p class="meta">${escapeHtml(card.setName)} - #${escapeHtml(card.number)} - ${escapeHtml(card.rarity)}</p>
      <p class="price">${formatPrice(card.price)}</p>
      <div class="detail-list">
        <div><strong>HP</strong>${escapeHtml(card.hp ?? "n/d")}</div>
        <div><strong>Tipi</strong>${escapeHtml(card.types.join(", ") || "n/d")}</div>
        <div><strong>Sottotipi</strong>${escapeHtml(card.subtypes.join(", ") || "n/d")}</div>
        <div><strong>Artista</strong>${escapeHtml(card.artist || "n/d")}</div>
      </div>
      <h3>Attacchi</h3>
      <ul>${attacks}</ul>
      <h3>Testo OCR</h3>
      <p class="meta">${escapeHtml(card.scanText || "n/d")}</p>
      <h3>Candidati OCR</h3>
      <p class="meta">${escapeHtml((card.ocrCandidates || []).join(", ") || "n/d")}</p>
      <p class="meta">Numero rilevato: ${escapeHtml(card.ocrCardNumber || "n/d")}</p>
    </article>
  `;
  showView("detail");
}

async function deleteCard(cardId) {
  await remove("cards", cardId);
  await refreshCollections();
  renderAll();
}

function renderDecks() {
  const deck = buildBestDeck(state.cards, state.settings.deckSize);
  els.deckRecommendation.innerHTML = renderDeck(deck, "Mazzo consigliato");
  els.savedDecks.innerHTML = state.decks.length
    ? state.decks.map((deck) => `<article class="saved-deck">${renderDeck(deck, escapeHtml(deck.name))}</article>`).join("")
    : emptyHtml("Nessun mazzo salvato", "Salva il mazzo consigliato quando l'archivio contiene carte sufficienti.");
}

function renderDeck(deck, title) {
  const notes = deck.notes.length ? deck.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("") : "<p>Nessuna criticita rilevata.</p>";
  const slots = deck.slots.slice(0, 18).map((slot) => `<div class="deck-slot"><span>${escapeHtml(slot.name)}</span><strong>x${slot.copies}</strong></div>`).join("");
  return `
    <h3>${title}</h3>
    <p>Archetipo: <strong>${escapeHtml(deck.archetype)}</strong></p>
    <p>Score: <strong>${deck.score}</strong> - Carte: <strong>${deck.cardCount}/${state.settings.deckSize}</strong></p>
    ${notes}
    <div class="deck-slots">${slots || "<p class='meta'>Archivio vuoto.</p>"}</div>
  `;
}

async function saveRecommendedDeck() {
  const deck = buildBestDeck(state.cards, state.settings.deckSize);
  const saved = { ...deck, id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, name: `${deck.archetype} core`, createdAt: Date.now() };
  await put("decks", saved);
  await refreshCollections();
  renderAll();
}

function buildBestDeck(cards, targetSize) {
  const scored = cards.map((card) => ({ card, score: scoreCard(card) })).sort((a, b) => b.score - a.score);
  const slots = [];
  let remaining = targetSize;
  let totalScore = 0;

  for (const item of scored) {
    if (remaining <= 0) break;
    const type = inferCategory(item.card);
    const limit = type === "Energy" ? 12 : 4;
    const copies = Math.min(remaining, limit, Math.max(1, Math.round(item.score / 28)));
    slots.push({ cardId: item.card.id, name: item.card.name, copies, type, setName: item.card.setName, price: item.card.price });
    remaining -= copies;
    totalScore += item.score * copies;
  }

  let guard = 0;
  while (remaining > 0 && scored.length && guard < scored.length * 12) {
    const item = scored[guard % scored.length];
    const type = inferCategory(item.card);
    const limit = type === "Energy" ? 12 : 4;
    const slot = slots.find((entry) => entry.cardId === item.card.id);
    if (slot && slot.copies < limit) {
      slot.copies += 1;
      remaining -= 1;
      totalScore += item.score;
    }
    guard += 1;
  }

  const cardCount = slots.reduce((sum, slot) => sum + slot.copies, 0);
  const archetype = inferArchetype(cards);
  return {
    archetype,
    score: Math.round(totalScore / Math.max(1, cardCount)),
    cardCount,
    slots,
    notes: summarizeDeck(slots, targetSize),
  };
}

function scoreCard(card) {
  const category = inferCategory(card);
  let score = 0;
  if (category === "Pokemon") {
    score += card.hp || 0;
    score += (card.raw?.attacks?.length || 0) * 18;
    score += card.raw?.evolvesFrom ? 8 : 12;
    score += (card.types?.length || 0) * 4;
  }
  if (category === "Trainer") {
    const name = card.name.toLowerCase();
    score += 24;
    if (name.includes("professor") || name.includes("research") || name.includes("boss") || name.includes("ball")) score += 42;
  }
  if (category === "Energy") score += 18;
  score += Math.min(40, card.price || 0) * 2;
  return Math.round(score);
}

function summarizeDeck(slots, targetSize) {
  const notes = [];
  const total = slots.reduce((sum, slot) => sum + slot.copies, 0);
  const pokemon = slots.filter((slot) => slot.type === "Pokemon").reduce((sum, slot) => sum + slot.copies, 0);
  const trainer = slots.filter((slot) => slot.type === "Trainer").reduce((sum, slot) => sum + slot.copies, 0);
  const energy = slots.filter((slot) => slot.type === "Energy").reduce((sum, slot) => sum + slot.copies, 0);
  if (total < targetSize) notes.push(`Mancano ${targetSize - total} carte per completare il mazzo.`);
  if (pokemon < 12) notes.push("Poche carte Pokemon rispetto a un mazzo competitivo standard.");
  if (trainer < 12) notes.push("Aggiungi Trainer per aumentare consistenza e ricerca carte.");
  if (energy < 10) notes.push("Energia potenzialmente insufficiente.");
  return notes;
}

function inferArchetype(cards) {
  const counts = new Map();
  for (const card of cards) {
    if (inferCategory(card) !== "Pokemon") continue;
    for (const type of card.types || []) counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Mixed";
}

function inferCategory(card) {
  const supertype = (card.supertype || "").toLowerCase();
  if (supertype.includes("trainer")) return "Trainer";
  if (supertype.includes("energy")) return "Energy";
  return "Pokemon";
}

async function saveSettingsFromForm(event) {
  event.preventDefault();
  state.settings = {
    backendUrl: trimSlash(els.backendUrl.value || DEFAULT_SETTINGS.backendUrl),
    pokeWalletApiKey: els.pokeWalletKey.value.trim(),
    tcgApiKey: els.tcgKey.value.trim(),
    deckSize: clamp(Number(els.deckSize.value) || 60, 40, 60),
  };
  await put("settings", { key: "app", value: state.settings });
  setStatus("Impostazioni salvate.");
  renderAll();
}

async function refreshCollections() {
  state.cards = (await getAll("cards")).sort((a, b) => b.createdAt - a.createdAt);
  state.decks = (await getAll("decks")).sort((a, b) => b.createdAt - a.createdAt);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("decks")) db.createObjectStore("decks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadSettings() {
  const saved = await get("settings", "app");
  return { ...DEFAULT_SETTINGS, ...(saved?.value || {}) };
}

function tx(store, mode = "readonly") {
  return state.db.transaction(store, mode).objectStore(store);
}

function get(store, key) {
  return wrapRequest(tx(store).get(key));
}

function getAll(store) {
  return wrapRequest(tx(store).getAll());
}

function put(store, value) {
  return wrapRequest(tx(store, "readwrite").put(value));
}

function remove(store, key) {
  return wrapRequest(tx(store, "readwrite").delete(key));
}

function wrapRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function renderScanResult(card, ocr, tcgCard, tcgError = "") {
  els.scanResult.hidden = false;
  const matchText = tcgCard ? "trovato" : tcgError ? `non disponibile (${tcgError})` : "non trovato";
  const candidates = (ocr.candidates || []).slice(0, 3).join(", ");
  els.scanResult.innerHTML = `
    <h3>${escapeHtml(card.name)}</h3>
    <p>${escapeHtml(card.setName)} - ${escapeHtml(card.rarity)}</p>
    <p>Confidenza OCR: <strong>${escapeHtml(ocr.confidence ?? "n/d")}</strong></p>
    <p>Numero carta OCR: <strong>${escapeHtml(ocr.cardNumber || "n/d")}</strong></p>
    <p>Candidati OCR: <strong>${escapeHtml(candidates || "n/d")}</strong></p>
    <p>Match TCG: <strong>${escapeHtml(matchText)}</strong></p>
    <button class="secondary-action" id="open-last-card">Apri dettaglio</button>
  `;
  document.querySelector("#open-last-card").addEventListener("click", () => openDetail(card.id));
}
function setStatus(message) {
  els.scanStatus.textContent = message;
}

function extractPrice(card) {
  if (!card) return null;
  const price = card.prices?.market || card.prices?.mid || card.tcgplayer?.prices?.normal?.market || card.tcgplayer?.prices?.holofoil?.market || card.tcgplayer?.prices?.reverseHolofoil?.market || card.cardmarket?.prices?.trendPrice || card.cardmarket?.prices?.averageSellPrice;
  return Number.isFinite(price) ? Number(price.toFixed(2)) : null;
}

function formatPrice(value) {
  return value == null ? "Prezzo n/d" : `EUR ${Number(value).toFixed(2)}`;
}
function emptyHtml(title, message) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeCardNumber(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9/]+/g, "").trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}




