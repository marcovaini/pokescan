# Architettura iniziale

## Moduli

### Mobile

Responsabile di:

- acquisizione immagini
- scansione e riconoscimento carta
- navigazione archivio
- visualizzazione prezzi e dettagli
- configurazione mazzi

### Ingestion API

Responsabile di:

- recupero dati carta
- aggiornamento quotazioni
- normalizzazione dei campi
- gestione cache e rate limit

### Database locale

Responsabile di:

- archiviazione carte
- immagini locali
- mazzi salvati
- storico aggiornamenti

### Deck Builder

Responsabile di:

- selezione carte legali
- controllo vincoli di formato
- valutazione sinergie
- composizione miglior lista possibile

## Entità principali

- Card
- CardImage
- Set
- MarketPrice
- CollectionEntry
- Deck
- DeckCard
- ScanSession

## Nota tecnica

Il motore mazzo dovrà essere separato dall’interfaccia, così da poter essere testato in modo deterministico.
