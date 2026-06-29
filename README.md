# PokemonScan

Webapp responsiva per:

- scansionare carte Pokemon dalla fotocamera del browser
- salvare immagini e informazioni complete in IndexedDB locale
- recuperare dati e quotazioni con PokeWallet come provider primario
- usare Pokemon TCG API come fallback opzionale
- calcolare un mazzo consigliato sulla base delle carte archiviate

## Stack attuale

- Web app vanilla HTML/CSS/JavaScript in `web/`
- Backend Node/TypeScript in `backend/`
- OCR via Tesseract.js esposto da `POST /ocr`
- Ricerca carte via `GET /cards/search?name=...`
- PokeWallet API primaria, Pokemon TCG API fallback
- Archivio locale browser con IndexedDB

Le cartelle `mobile/` e `PokemonScanNative/` restano come prototipi precedenti. La versione da distribuire e la webapp servita dal backend Node.

## Sviluppo locale

```powershell
cd C:\Sviluppo\WORKSPACE_AI\CODEX_APP\_PERSONAL_\PokemonScan\backend
npm.cmd install
npm.cmd run dev
```

Apri poi `http://localhost:8787`.

## Deploy su Render

Il repository include [render.yaml](C:\Sviluppo\WORKSPACE_AI\CODEX_APP\_PERSONAL_\PokemonScan\render.yaml), quindi puoi creare il servizio direttamente dal repo.

Variabili ambiente richieste:

- `POKEWALLET_API_KEY`
- `POKEMON_TCG_API_KEY` opzionale
- `PORT` viene gestita da Render automaticamente

Comandi usati da Render:

- build: `npm install && npm run build`
- start: `npm run start`

Render esegue il servizio nella cartella `backend/`, ma il server serve anche gli asset statici presenti in `web/`.

## Configurazione app

Nella schermata `Impostazioni`:

- `Backend OCR`: in locale lascia `http://localhost:8787`
- `Chiave PokeWallet API`: opzionale se la chiave e gia impostata sul server; utile solo in locale
- `Chiave Pokemon TCG API fallback`: opzionale
- `Dimensione mazzo`: 40-60 carte