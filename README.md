# W Motion Portfolio

Portfolio one-page responsive con hero video sincronizzata allo scroll.

## Apertura rapida su Windows

Fai doppio clic su `AVVIA-SITO.cmd`. Si aprirà automaticamente la versione completa nel browser.

L’avvio con `AVVIA-SITO.cmd` è consigliato perché abilita il percorso completo WebCodecs. Se `index.html` viene aperto direttamente, il sito mantiene grafica, animazioni dei testi e scroll-scrub attraverso il proxy MP4 compatibile.

## Avvio per sviluppo

Richiede Node.js 20.19+ oppure 22.12+.

```bash
npm install
npm run dev
```

Aprire l’indirizzo mostrato nel terminale.

## Build di produzione

```bash
npm run build
npm run preview
```

L’output statico viene generato nella cartella `dist/`.

## Architettura della hero

- `public/media/hero-manifest.json` descrive durata, profili e segmenti.
- I proxy `high` (1280×720) e `medium` (854×480) sono selezionati in base a viewport, memoria del dispositivo e qualità della connessione.
- I segmenti MP4 da 0,75 secondi a 24 fps vengono demuxati con MP4Box e decodificati con WebCodecs.
- Un buffer circolare conserva solo i frame del segmento corrente e del successivo.
- Il playhead insegue lo scroll con velocità massima controllata, evitando salti bruschi.
- I desktop compatibili usano segmenti H.264 1920×1080; tablet e mobile ricevono proxy adattivi più leggeri.
- Browser non compatibili usano `w-motion-hero-fallback-v3-1080.mp4`, un proxy H.264 1920×1080 con keyframe frequenti per rendere fluido lo scrub.
- Con l’opzione di sistema “movimento ridotto” la hero resta statica e leggibile.

## Sistema visivo

- Space Grotesk Variable per marchio, titoli, navigazione ed etichette.
- Manrope Variable per i testi lunghi.
- Entrambi i font sono inclusi localmente: non dipendono da Google Fonts o da connessioni esterne.
- Il simbolo W nell’header è una risorsa PNG trasparente, separata dal riquadro dell’immagine originale.

Il master originale usato per questa versione è conservato in `source-assets/video-hero-portfolio-v3.mp4`. Per sostituirlo, aggiornare i file in `public/media`, rigenerare i segmenti e modificare il manifest.
