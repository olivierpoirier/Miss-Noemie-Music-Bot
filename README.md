# Music Bot

Interface web et backend local pour piloter un bot musical avec routage audio virtuel.

## Mode local

Le mode local reste le mode complet de l'application. Il utilise le backend Socket.IO dans `backend/src/server.ts`, le lecteur local, mpv et la verification du routage audio virtuel.

Premiere installation:

```bash
npm run setup
```

Lancer le backend, le frontend et un tunnel Cloudflare pour tes amis:

```bash
npm run dev
```

Cette commande lance le backend sur `http://localhost:4000`, attend qu'il soit pret, lance le frontend Vite sur `http://localhost:5173` ou sur le prochain port libre, puis lance Cloudflare.

Partage l'URL `trycloudflare.com` affichee par Cloudflare. Le frontend passe par ce tunnel et relaie automatiquement Socket.IO vers le backend local. Le tunnel utilise automatiquement le port frontend choisi par le lanceur.

Lancer seulement en local, sans tunnel Cloudflare:

```bash
npm run dev:local
```

Le build de production local ne change pas:

```bash
npm --prefix backend run build
npm --prefix frontend run build
```

Le build local du frontend ecrit dans `frontend/dist`, qui est le dossier servi par le backend local.

## Demo Vercel

La demo Vercel est volontairement isolee du backend local. Elle sert uniquement a permettre a des visiteurs d'essayer le frontend depuis un lien web, sans mpv, sans Voicemeeter et sans lecture audio serveur.

Fichiers dedies a la demo:

- `vercel.json`: configuration de build Vercel, avec sortie dans `frontend/dist-vercel`.
- `api/demo.js`: backend HTTP de demonstration, avec etat temporaire en memoire.
- `frontend/src/hooks/useVercelDemoQueue.ts`: client frontend utilise seulement par le build Vercel.
- `frontend/src/components/DemoAudioNotice.tsx`: message visible seulement sur la demo Vercel.

Le script Vercel entre dans `frontend`, lance `npm ci`, puis utilise `vite build --mode vercel`; ce mode active automatiquement le client de demo. Le script local normal `npm --prefix frontend run build` continue d'utiliser le backend Socket.IO reel et ecrit dans `frontend/dist`.

```bash
npm --prefix frontend run build:vercel
```
