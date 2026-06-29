# Music Bot

Interface web et backend local pour piloter un bot musical avec routage audio virtuel.

## Mode local

Le mode local reste le mode complet de l'application. Il utilise le backend Socket.IO dans `backend/src/server.ts`, le lecteur local, mpv et la vérification du routage audio virtuel.

```bash
npm --prefix backend run dev
npm --prefix frontend run start
```

Le build de production local ne change pas:

```bash
npm --prefix backend run build
npm --prefix frontend run build
```

## Démo Vercel

La démo Vercel est volontairement isolée du backend local. Elle sert uniquement à permettre à des visiteurs d'essayer le frontend depuis un lien web, sans mpv, sans Voicemeeter et sans lecture audio serveur.

Fichiers dédiés à la démo:

- `vercel.json`: configuration de build Vercel.
- `api/demo.js`: backend HTTP de démonstration, avec état temporaire en mémoire.
- `frontend/src/hooks/useVercelDemoQueue.ts`: client frontend utilisé seulement par le build Vercel.

Le script Vercel entre dans `frontend`, lance `npm ci`, puis utilise `vite build --mode vercel`; ce mode active automatiquement le client de démo. Le script local normal `npm --prefix frontend run build` continue d'utiliser le backend Socket.IO réel.

```bash
npm --prefix frontend run build:vercel
```
