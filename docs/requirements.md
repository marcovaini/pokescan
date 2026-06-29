# Requisiti funzionali

## Funzioni principali

- scansione carta Pokémon tramite fotocamera
- riconoscimento carta tramite immagine o OCR
- salvataggio locale di:
  - immagine della carta
  - nome
  - set
  - numero carta
  - rarità
  - tipologia
  - statistiche
  - attacchi
  - abilità
  - debolezze e resistenze
  - prezzo/quotazione aggiornata
- sincronizzazione periodica con API TCG
- ricerca nell’archivio locale
- generazione del miglior mazzo possibile sulla base delle carte possedute

## Vincoli

- funzionamento offline per consultazione archivio locale
- database locale persistente sul dispositivo
- aggiornamento prezzi e metadati da sorgente esterna
- logica deck builder conforme alle regole ufficiali del gioco

## Scelte aperte

- stack mobile
- database locale
- strategia di riconoscimento carte
- provider API TCG
- algoritmo di costruzione mazzo
