# Diagnostiquer une interruption de lecture

Ouvre **Diagnostic du bot**, sous la file et l'historique. Si l'alerte audio masque l'interface, son bouton **Voir le diagnostic** ouvre le panneau; le backend continue de bloquer la lecture tant que la route audio virtuelle est absente.

Le panneau affiche l'état du serveur, le moteur mpv, la préparation de la piste, le routage virtuel, les exécutables utilisés et les 100 derniers événements disponibles. Il actualise le relevé toutes les 15 secondes uniquement lorsqu'il est ouvert et que l'onglet est visible. Le bouton d'export télécharge les mêmes champs publics dans un fichier JSON.

## Vérifier les outils

```bash
npm run doctor
```

Cette commande exécute uniquement `--version` sur les outils configurés. Elle n'ouvre pas de périphérique audio et ne teste pas les comptes Spotify ou YouTube. Les contrôles sont bornés à quatre secondes par outil. Une version yt-dlp datée de plus de 90 jours est signalée; cela constitue un indice de maintenance, pas une preuve de panne.

Le bot privilégie `YTDLP_BIN`, puis le binaire livré dans `backend/node_modules/yt-dlp-exec/bin`, puis celui du PATH. Le panneau et la commande affichent le chemin réellement résolu. Pour mettre à jour cette même copie :

```bash
npm run update:ytdlp
```

La mise à jour est explicite et nécessite réseau et droits d'écriture. Le bot ne télécharge aucun nouvel exécutable en arrière-plan. Une installation yt-dlp gérée par un autre gestionnaire de paquets peut exiger sa propre commande de mise à jour. Relance ensuite `npm run doctor`; le serveur revérifie les versions au plus toutes les dix minutes, ou à son prochain démarrage.

## Lire les événements

| Catégorie | Ce qu'elle permet de distinguer |
| --- | --- |
| `spotify` | Refus HTTP, limitation de requêtes, expiration/révocation d'autorisation ou délai réseau. |
| `ytdlp` | Échec ou délai d'extraction et résolution réussie d'une source. |
| `mpv` | Démarrage, sortie inattendue du moteur ou perte de communication IPC. |
| `player` | Lecture démarrée, absence de progression, nouvelle tentative ou abandon d'une piste. |
| `audio` | Routage virtuel prêt ou indisponible. |
| `server` | Démarrage/arrêt du serveur et commande invalide ou échouée. |
| `tools` | État de vérification des exécutables. |

Les événements possèdent un horodatage, un code stable et, quand disponibles, le statut HTTP, le code de sortie du processus, le motif normalisé, le numéro de tentative et la durée. Le journal conserve des messages définis par l'application; il n'enregistre pas les messages bruts des fournisseurs, les cookies, les jetons, les titres ni les URL audio signées.

## Conservation

Le journal se trouve par défaut dans `.data/logs/events.ndjson`. Il est ignoré par Git et tourne sur trois fichiers d'environ 1 Mio chacun (`events.ndjson`, `.1`, `.2`). Les événements récents sont relus au démarrage, y compris après une dernière ligne tronquée par un arrêt brutal. Les écritures sont ordonnées et leur attente est bornée; une saturation ou une erreur disque ne bloque pas la lecture.

`DIAGNOSTICS_LOG_DIR` change le dossier, `DIAGNOSTICS_MAX_BYTES` la taille par fichier et `DIAGNOSTICS_ENABLED=false` désactive l'écriture sur disque. Dans ce dernier cas, les événements restent disponibles en mémoire jusqu'au redémarrage. Le journal ne garantit pas une durée fixe de conservation : celle-ci dépend du nombre d'événements. Un dossier différent doit être utilisé pour chaque instance de serveur.

L'API `GET /diagnostics` renvoie le même relevé public et ne lance aucune lecture. Le backend reste accessible avec l'option `VITE_API_BASE`, ou à l'adresse configurée par `VITE_SERVER_URL`; le développement local utilise le proxy Vite. La démo Vercel indique que ces outils ne sont disponibles que dans l'application locale.

L'état de la file et l'historique musical restent en mémoire : ce journal conserve les incidents, pas une sauvegarde des morceaux. Une fréquence supposée de deux semaines ne peut être confirmée qu'en comparant les événements enregistrés aux dates des interruptions.

## Modules communs

`backend/src/queue.ts` centralise les mutations synchrones de file et d'historique; les transitions asynchrones et les annulations restent dans `player.ts`. `shared/contracts.d.ts` définit les contrats frontend/backend. `shared/playback.js` fournit l'horloge et le formatage utilisés par le serveur, le lecteur, l'interface et la démo. Les imports fonctionnent en développement Vite, avec le backend compilé et dans la démo CommonJS.
