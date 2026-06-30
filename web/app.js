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
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 2160, max: 4096 },
        height: { ideal: 3840, max: 4096 },
        aspectRatio: { ideal: 0.72 }
      },
      audio: false,
    });
    els.camera.srcObject = state.stream;
    await els.camera.play().catch(() => undefined);

    const track = state.stream.getVideoTracks()[0];
    state.photoCapture = typeof ImageCapture !== "undefined" ? new ImageCapture(track) : null;
    const settings = track?.getSettings?.() || {};
    const capabilities = track?.getCapabilities?.() || {};
    const width = settings.width || els.camera.videoWidth || "n/d";
    const height = settings.height || els.camera.videoHeight || "n/d";
    const maxWidth = capabilities.width?.max || width;
    const maxHeight = capabilities.height?.max || height;

    state.cameraInfo = `${width}x${height}${maxWidth && maxHeight ? ` (max ${maxWidth}x${maxHeight})` : ""}`;
    setStatus(`Camera attiva ${state.cameraInfo}. Inquadra la carta e scatta.`);
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

  const imageDataUrl = await captureFrame();
  setStatus("Analisi AI in corso...");

  try {
    const ocr = await recognize(imageDataUrl);
    const recognized = ocr.suggestedName || ocr.candidates?.[0] || "nome non sicuro";
    setStatus(`Analisi AI completata: ${recognized}`);

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
      setStatus("Carta salvata. Analisi AI completata ma nessun match affidabile trovato.");
    } else {
      setStatus("Carta salvata nell'archivio locale.");
    }
  } catch (error) {
    setStatus(`Scansione fallita: ${readError(error)}`);
  }
}

async function captureFrame() {
  if (state.photoCapture?.takePhoto) {
    try {
      const blob = await state.photoCapture.takePhoto();
      return await cropBlobToGuide(blob);
    } catch (error) {
      console.warn("takePhoto failed, falling back to video frame", error);
    }
  }

  return captureVideoFrame();
}

async function cropBlobToGuide(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = els.canvas;
  const region = getGuideCaptureRegionForSource(
    els.camera,
    els.cameraGuide,
    bitmap.width,
    bitmap.height
  );

  canvas.width = region.sw;
  canvas.height = region.sh;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, region.sx, region.sy, region.sw, region.sh, 0, 0, region.sw, region.sh);
  if (typeof bitmap.close === "function") bitmap.close();
  return canvas.toDataURL("image/png");
}

function captureVideoFrame() {
  const video = els.camera;
  const canvas = els.canvas;
  const videoWidth = video.videoWidth || 900;
  const videoHeight = video.videoHeight || 1200;
  const region = getGuideCaptureRegionForSource(video, els.cameraGuide, videoWidth, videoHeight);

  canvas.width = region.sw;
  canvas.height = region.sh;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, region.sw, region.sh);
  return canvas.toDataURL("image/png");
}

function getGuideCaptureRegionForSource(video, guide, sourceWidth, sourceHeight) {
  if (!guide) {
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight };
  }

  const videoRect = video.getBoundingClientRect();
  const guideRect = guide.getBoundingClientRect();
  const scale = Math.min(sourceWidth / videoRect.width, sourceHeight / videoRect.height);

  const contentWidth = videoRect.width * scale;
  const contentHeight = videoRect.height * scale;
  const offsetX = Math.max(0, (sourceWidth - contentWidth) / 2);
  const offsetY = Math.max(0, (sourceHeight - contentHeight) / 2);

  const left = Math.max(0, (guideRect.left - videoRect.left) * scale + offsetX);
  const top = Math.max(0, (guideRect.top - videoRect.top) * scale + offsetY);
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
  if (!response.ok) throw new Error(`backend AI ${response.status}`);
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
    .filter((value, index) => value && index < 3);
  const cardNumber = String(ocr.cardNumber || "").trim();
  const setName = String(ocr.setName || ocr.series || "").trim();
  const setCode = String(ocr.setCode || "").trim();
  const queries = [];

  if (names[0] && cardNumber) queries.push(`${names[0]} ${cardNumber}`);
  if (names[0] && setName && cardNumber) queries.push(`${names[0]} ${setName} ${cardNumber}`);
  if (names[0] && setCode && cardNumber) queries.push(`${names[0]} ${setCode} ${cardNumber}`);
  if (setName && cardNumber) queries.push(`${setName} ${cardNumber}`);
  if (setCode && cardNumber) queries.push(`${setCode} ${cardNumber}`);
  names.forEach((name) => queries.push(name));
  if (cardNumber) queries.push(cardNumber);
  if (setName) queries.push(setName);
  if (setCode) queries.push(setCode);
  return uniqueStrings(queries);
}

function selectBestCard(cards, ocr) {
  if (!cards.length) return null;

  const names = [ocr.suggestedName, ...(ocr.candidates || [])]
    .map(normalizeText)
    .filter((value, index) => value && index < 3);
  const primaryName = names[0] || "";
  const number = normalizeCardNumber(ocr.cardNumber);
  const setName = normalizeText(ocr.setName || ocr.series || "");
  const setCode = normalizeText(ocr.setCode || "");
  let best = null;
  let bestScore = -1;

  for (const card of cards) {
    const cardName = normalizeText(card.name);
    const cardNumber = normalizeCardNumber(card.number);
    const cardSetName = normalizeText(card.set?.name || card.setName || "");
    const cardSetCode = normalizeText(card.set?.id || card.set?.code || "");
    let score = 0;

    if (primaryName && cardName === primaryName) score += 160;
    if (primaryName && similarity(cardName, primaryName) >= 0.88) score += 100;
    if (names.includes(cardName)) score += 60;
    if (number && cardNumber === number) score += 200;
    if (number && cardNumber && cardNumber.startsWith(number.split("/")[0] || "")) score += 35;
    if (setName && cardSetName === setName) score += 90;
    if (setCode && cardSetCode === setCode) score += 120;
    if (setName && cardSetName && (cardSetName.includes(setName) || setName.includes(cardSetName))) score += 30;
    if (card.images?.large || card.images?.small) score += 5;

    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }

  return bestScore >= 90 ? best : null;
}

function createStoredCard({ imageDataUrl, ocr, tcgCard }) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const attacks = normalizeAttacks(tcgCard?.attacks || ocr.attacks || []);
  return {
    id,
    tcgId: tcgCard?.id || id,
    name: tcgCard?.name || ocr.pokemonName || ocr.suggestedName || ocr.candidates?.[0] || "Carta sconosciuta",
    setName: tcgCard?.set?.name || ocr.setName || ocr.series || "Set non riconosciuto",
    setCode: tcgCard?.set?.id || tcgCard?.set?.code || ocr.setCode || "",
    number: ocr.cardNumber || tcgCard?.number || "n/d",
    stage: tcgCard?.stage || ocr.cardType || "",
    cardType: ocr.cardType || tcgCard?.stage || tcgCard?.supertype || "Pokemon",
    rarity: tcgCard?.rarity || ocr.rarity || "n/d",
    supertype: tcgCard?.supertype || ocr.cardType || "Pokemon",
    subtypes: tcgCard?.subtypes || ocr.subtypes || [],
    hp: tcgCard?.hp ? Number.parseInt(tcgCard.hp, 10) || null : (ocr.hp ? Number.parseInt(ocr.hp, 10) || null : null),
    types: tcgCard?.types || ocr.types || [],
    pokemonType: ocr.pokemonType || tcgCard?.pokemonType || (Array.isArray(tcgCard?.types) ? tcgCard.types.join(", ") : ""),
    apiPokemonType: tcgCard?.pokemonType || "",
    apiStage: tcgCard?.stage || "",
    artist: tcgCard?.artist || ocr.artist || "n/d",
    imageUrl: tcgCard?.images?.large || tcgCard?.images?.small || "",
    localImage: imageDataUrl,
    price: extractPrice(tcgCard),
    raw: tcgCard || {},
    scanText: ocr.rawText || "",
    ocrCandidates: ocr.candidates || [],
    ocrCardNumber: ocr.cardNumber || "",
    ocrSeries: ocr.series || ocr.setName || "",
    ocrSetName: ocr.setName || ocr.series || "",
    ocrSetCode: ocr.setCode || "",
    ocrCardType: ocr.cardType || "",
    ocrPokemonType: ocr.pokemonType || "",
    ocrPokemonTypes: ocr.types || [],
    ocrHp: ocr.hp || "",
    ocrAttacks: attacks,
    ocrWeakness: ocr.weakness || "",
    ocrResistance: ocr.resistance || "",
    ocrRetreatCost: ocr.retreatCost || "",
    ocrDescription: resolveDescription({ description: ocr.description, raw: tcgCard?.raw }, attacks),
    createdAt: Date.now(),
  };
}

function normalizeAttacks(attacks) {
  if (!Array.isArray(attacks)) return [];
  return attacks
    .map((attack) => {
      if (typeof attack === "string") {
        const cleaned = attack.replace(/<br\s*\/?>(\s*)/gi, "\n").trim();
        if (!cleaned) return null;
        const [headline, ...tail] = cleaned.split(/\n+/);
        const firstLine = String(headline || "").trim();
        const secondLine = String(tail.join(" ") || "").trim();
        const nameFromBracket = firstLine.match(/^\[(.*?)\]\s*(.*)$/);
        const name = String(nameFromBracket?.[2] || firstLine).trim();
        const description = secondLine || String(firstLine).replace(/^\[(.*?)\]\s*/, "").trim();
        return { name, description };
      }

      const name = String(attack?.name || attack?.attack || attack?.title || "").trim();
      const description = String(attack?.description || attack?.text || attack?.effect || attack?.raw || "").trim();
      if (!name && !description) return null;
      return { name, description };
    })
    .filter(Boolean);
}

function resolveDescription(source, attacks = []) {
  const explicit = source?.ocrDescription || source?.description || source?.raw?.card_info?.card_text || source?.raw?.card_text || source?.raw?.flavorText || source?.raw?.flavor_text || "";
  if (String(explicit || "").trim()) return String(explicit).trim();
  const normalizedAttacks = normalizeAttacks(attacks);
  return normalizedAttacks
    .map((attack) => attack.description)
    .filter(Boolean)
    .join(" ")
    .trim();
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
  renderDetail(card);
  showView("detail");
}

function renderDetail(card) {
  const attacks = normalizeAttacks(card.ocrAttacks || card.raw?.attacks || []);
  const weaknesses = card.ocrWeakness || card.raw?.weaknesses?.[0]?.type || "";
  const resistance = card.ocrResistance || card.raw?.resistances?.[0]?.type || "";
  const retreatCost = card.ocrRetreatCost || card.raw?.retreatCost?.join?.(", ") || "";
  const description = resolveDescription(card, attacks);
  const attackEditorValue = serializeAttacks(attacks);
  const imageUrl = getCardImageUrl(card);
  const providerPrices = formatProviderPrices(card.prices);
  els.detailContent.innerHTML = `
    <img src="${escapeAttr(imageUrl || card.localImage || "")}" alt="${escapeAttr(card.name)}" />
    <article class="detail-panel">
      <p class="eyebrow">${escapeHtml(card.cardType || card.supertype)}</p>
      <h2>${escapeHtml(card.name)}</h2>
      <p class="meta">${escapeHtml(card.setName)} - #${escapeHtml(card.number)} - ${escapeHtml(card.rarity)}</p>
      <p class="price">${formatPrice(card.price)}</p>
      <div class="detail-summary">
        ${renderSummaryItem("Set code", card.setCode || card.ocrSetCode || "n/d")}
        ${renderSummaryItem("Set ID", card.setId || card.raw?.set?.id || "n/d")}
        ${renderSummaryItem("Rarit?", card.rarity || "n/d")}
        ${renderSummaryItem("Artista", card.artist || "n/d")}
        ${renderSummaryItem("Supertype", card.supertype || "n/d")}
        ${renderSummaryItem("Sottotipi", formatList(card.subtypes))}
        ${renderSummaryItem("Tipi", formatList(card.types))}
        ${renderSummaryItem("Prezzi provider", providerPrices)}
      </div>
      <div class="detail-form">
        <label><span>Nome carta</span><input data-edit-field="name" type="text" value="${escapeAttr(card.name)}"></label>
        <label><span>Numero carta</span><input data-edit-field="number" type="text" value="${escapeAttr(card.number || "")}"></label>
        <label><span>Serie</span><input data-edit-field="setName" type="text" value="${escapeAttr(card.ocrSeries || card.ocrSetName || card.setName || "")}"></label>
        <label><span>Tipo carta</span><input data-edit-field="cardType" type="text" value="${escapeAttr(card.cardType || card.supertype || card.stage || "")}"></label>
        <label><span>Tipo Pok?mon</span><input data-edit-field="pokemonType" type="text" value="${escapeAttr(card.pokemonType || card.ocrPokemonType || (card.types && card.types.join(", ")) || "")}"></label>
        <label><span>HP</span><input data-edit-field="hp" type="text" value="${escapeAttr(card.hp ?? card.ocrHp ?? "")}"></label>
        <label><span>Debolezza</span><input data-edit-field="weakness" type="text" value="${escapeAttr(weaknesses)}"></label>
        <label><span>Resistenza</span><input data-edit-field="resistance" type="text" value="${escapeAttr(resistance)}"></label>
        <label><span>Ritirata</span><input data-edit-field="retreatCost" type="text" value="${escapeAttr(retreatCost)}"></label>
        <label class="field-wide"><span>Descrizione</span><textarea data-edit-field="description">${escapeHtml(description)}</textarea></label>
        <label class="field-wide"><span>Mosse (una per riga: nome | descrizione)</span><textarea data-edit-field="attacks">${escapeHtml(attackEditorValue)}</textarea></label>
      </div>
      <div class="inline-actions">
        <button id="save-card-edits" type="button">Salva modifiche</button>
        <button class="secondary-action" id="sync-pokewallet-card" type="button">Aggiorna da Pok?Wallet</button>
        <a class="secondary-action" href="${escapeAttr(imageUrl || "#")}" download>Scarica immagine</a>
        <button class="secondary-action" id="reload-card-detail">Ripristina analisi</button>
      </div>
      <h3>Attacchi rilevati</h3>
      <ul>${renderAttackList(attacks)}</ul>
      <h3>Dati estratti</h3>
      <p class="meta">${escapeHtml(card.scanText || "n/d")}</p>
      <p class="meta">Numero rilevato: ${escapeHtml(card.ocrCardNumber || "n/d")}</p>
      <p class="meta">Serie rilevata: ${escapeHtml(card.ocrSeries || card.ocrSetName || card.ocrSetCode || "n/d")}</p>
    </article>
  `;

  els.detailContent.querySelector("#save-card-edits").addEventListener("click", async () => {
    await saveCardEdits(card.id);
  });
  els.detailContent.querySelector("#sync-pokewallet-card").addEventListener("click", async () => {
    await syncCardFromPokeWallet(card.id);
  });
  els.detailContent.querySelector("#reload-card-detail").addEventListener("click", () => {
    renderDetail(state.cards.find((item) => item.id === card.id) || card);
  });
}

function renderAttackList(attacks) {
  if (!Array.isArray(attacks) || !attacks.length) {
    return "<li>n/d</li>";
  }

  return normalizeAttacks(attacks).map((attack) => {
    const name = escapeHtml(attack?.name || "");
    const description = escapeHtml(attack?.description || attack?.text || "");
    if (!name && !description) {
      return "<li>n/d</li>";
    }
    return `<li><strong>${name || "n/d"}</strong>${description ? ` ${description}` : ""}</li>`;
  }).join("");
}

function serializeAttacks(attacks) {
  return normalizeAttacks(attacks)
    .map((attack) => `${attack.name || ""}${attack.description ? ` | ${attack.description}` : ""}`.trim())
    .join("\n");
}

function parseAttackEditor(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart, ...rest] = line.split("|");
      const name = String(namePart || "").trim();
      const description = String(rest.join("|") || "").trim();
      return { name, description };
    })
    .filter((attack) => attack.name || attack.description);
}

async function saveCardEdits(cardId) {
  const index = state.cards.findIndex((item) => item.id === cardId);
  if (index === -1) return;

  const current = state.cards[index];
  const read = (field) => els.detailContent.querySelector(`[data-edit-field="${field}"]`)?.value?.trim() || "";
  const editedAttacks = parseAttackEditor(read("attacks"));
  const edited = {
    ...current,
    name: read("name") || current.name,
    number: read("number") || current.number,
    setName: read("setName") || current.setName,
    ocrSeries: read("setName") || current.ocrSeries,
    ocrSetName: read("setName") || current.ocrSetName,
    stage: read("cardType") || current.stage,
    cardType: read("cardType") || current.cardType,
    ocrCardType: read("cardType") || current.ocrCardType,
    pokemonType: read("pokemonType") || current.pokemonType || current.ocrPokemonType,
    ocrPokemonType: read("pokemonType") || current.ocrPokemonType,
    ocrPokemonTypes: read("pokemonType") ? read("pokemonType").split(",").map((value) => value.trim()).filter(Boolean) : current.ocrPokemonTypes,
    hp: read("hp") ? Number.parseInt(read("hp"), 10) || null : current.hp,
    ocrHp: read("hp") || current.ocrHp,
    ocrWeakness: read("weakness") || current.ocrWeakness,
    ocrResistance: read("resistance") || current.ocrResistance,
    ocrRetreatCost: read("retreatCost") || current.ocrRetreatCost,
    ocrDescription: read("description") || current.ocrDescription,
    ocrAttacks: editedAttacks.length ? editedAttacks : current.ocrAttacks,
  };

  state.cards[index] = edited;
  await put("cards", edited);
  await refreshCollections();
  renderAll();
  renderDetail(edited);
  setStatus("Correzioni salvate nell'archivio locale.");
}

async function syncCardFromPokeWallet(cardId) {
  const index = state.cards.findIndex((item) => item.id === cardId);
  if (index === -1) return;

  const current = state.cards[index];
  const hint = {
    suggestedName: current.name,
    candidates: [current.name, ...(current.ocrCandidates || [])].filter(Boolean),
    cardNumber: current.ocrCardNumber || current.number || "",
    setName: current.ocrSeries || current.ocrSetName || current.setName || "",
    series: current.ocrSeries || current.ocrSetName || current.setName || "",
    setCode: current.ocrSetCode || current.setCode || "",
  };

  setStatus("Interrogazione PokéWallet in corso...");
  try {
    const queries = buildSearchQueries(hint);
    const pokewalletCard = await searchCardCandidates(queries, hint);
    if (!pokewalletCard) {
      throw new Error("Nessun match affidabile trovato su PokéWallet");
    }

    const merged = mergePokeWalletCard(current, pokewalletCard);
    state.cards[index] = merged;
    await put("cards", merged);
    await refreshCollections();
    renderAll();
    renderDetail(merged);
    setStatus(`Scheda aggiornata con PokéWallet: ${pokewalletCard.name}`);
  } catch (error) {
    setStatus(`Aggiornamento PokéWallet fallito: ${readError(error)}`);
    console.error(error);
  }
}

function mergePokeWalletCard(current, providerCard) {
  const attacks = normalizeAttacks(providerCard?.attacks || providerCard?.raw?.card_info?.attacks || []);
  const setName = providerCard?.set?.name || providerCard?.setName || current.setName || "";
  const setId = providerCard?.set?.id || providerCard?.setId || current.setId || "";
  const setCode = providerCard?.setCode || current.setCode || providerCard?.raw?.card_info?.set_code || "";
  const number = providerCard?.number || current.number || "n/d";
  const name = providerCard?.name || current.name;
  const pokemonType = providerCard?.pokemonType || (Array.isArray(providerCard?.types) ? providerCard.types.join(", ") : "") || current.pokemonType || current.ocrPokemonType || "";
  const stage = providerCard?.stage || providerCard?.cardType || current.stage || "";
  const cardType = providerCard?.cardType || stage || current.cardType || "Pokemon";
  const hp = providerCard?.hp ? Number.parseInt(providerCard.hp, 10) || null : current.hp;
  const price = extractPrice(providerCard) ?? current.price;
  const pokewalletId = providerCard?.id || current.pokewalletId || providerCard?.raw?.id || "";
  const imageUrl = providerCard?.images?.large || providerCard?.images?.small || (pokewalletId ? `${normalizeBackendUrl(state.settings.backendUrl)}/cards/${encodeURIComponent(pokewalletId)}/image?size=high` : "") || current.imageUrl || "";

  return {
    ...current,
    name,
    setName,
    setId,
    setCode,
    number,
    stage,
    cardType,
    pokemonType,
    types: Array.isArray(providerCard?.types) && providerCard.types.length ? providerCard.types : current.types,
    hp,
    rarity: providerCard?.rarity || current.rarity,
    supertype: providerCard?.supertype || current.supertype,
    subtypes: Array.isArray(providerCard?.subtypes) && providerCard.subtypes.length ? providerCard.subtypes : current.subtypes,
    artist: providerCard?.artist || current.artist,
    imageUrl,
    price,
    raw: providerCard?.raw || providerCard,
    apiPokemonType: pokemonType,
    apiStage: stage,
    ocrAttacks: attacks.length ? attacks : current.ocrAttacks,
    ocrWeakness: providerCard?.weakness || current.ocrWeakness,
    ocrResistance: providerCard?.resistance || current.ocrResistance,
    ocrRetreatCost: providerCard?.retreatCost || current.ocrRetreatCost,
    ocrDescription: resolveDescription({ description: providerCard?.description, raw: providerCard?.raw }, attacks) || current.ocrDescription,
    pokewalletId,
    pokewalletImageUrl: imageUrl,
    pokewalletCard: providerCard,
    updatedAt: Date.now(),
  };
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
  const attackPreview = (ocr.attacks || []).slice(0, 3).map((attack) => attack.name).join(", ");
  els.scanResult.innerHTML = `
    <h3>${escapeHtml(card.name)}</h3>
    <p>${escapeHtml(card.setName)} - ${escapeHtml(card.rarity)}</p>
    <div class="detail-summary detail-summary--compact">
      ${renderSummaryItem("Set code", card.setCode || "n/d")}
      ${renderSummaryItem("Rarit?", card.rarity || "n/d")}
      ${renderSummaryItem("Artista", card.artist || "n/d")}
      ${renderSummaryItem("Pok?mon type", card.pokemonType || "n/d")}
    </div>
    <p>Confidenza AI: <strong>${escapeHtml(ocr.confidence ?? "n/d")}</strong></p>
    <p>Tipo carta: <strong>${escapeHtml(ocr.cardType || "n/d")}</strong></p>
    <p>Tipo Pok?mon: <strong>${escapeHtml((ocr.types && ocr.types.join(", ")) || ocr.pokemonType || "n/d")}</strong></p>
    <p>Numero carta: <strong>${escapeHtml(ocr.cardNumber || "n/d")}</strong></p>
    <p>Serie: <strong>${escapeHtml(ocr.setName || ocr.setCode || "n/d")}</strong></p>
    <p>Candidati: <strong>${escapeHtml(candidates || "n/d")}</strong></p>
    <p>Mosse: <strong>${escapeHtml(attackPreview || "n/d")}</strong></p>
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
function formatProviderPrices(prices) {
  if (!prices) return "n/d";
  const parts = [];
  if (prices.market != null) parts.push(`market ${Number(prices.market).toFixed(2)}`);
  if (prices.low != null) parts.push(`low ${Number(prices.low).toFixed(2)}`);
  if (prices.mid != null) parts.push(`mid ${Number(prices.mid).toFixed(2)}`);
  if (prices.high != null) parts.push(`high ${Number(prices.high).toFixed(2)}`);
  return parts.length ? parts.join(" | ") : "n/d";
}
function formatList(values) {
  return Array.isArray(values) && values.length ? values.join(", ") : "n/d";
}
function renderSummaryItem(label, value) {
  return `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`;
}
function getCardImageUrl(card) {
  return card?.pokewalletImageUrl || card?.imageUrl || card?.localImage || "";
}
function normalizeBackendUrl(value) {
  return String(value || "").trim().replace(/\/$/, "") || window.location.origin;
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

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = left.split(" ");
  const b = right.split(" ");
  const overlap = a.filter((part) => b.includes(part)).length;
  return overlap / Math.max(a.length, b.length, 1);
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






