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

## Consulter le journal dans le terminal

Depuis la racine du projet :

```bash
npm run logs
npm run logs -- --follow
```

La première commande affiche les 100 derniers événements. La seconde suit les nouveaux événements et les rotations du journal; `Ctrl+C` arrête uniquement cette consultation. Les deux commandes respectent `DIAGNOSTICS_LOG_DIR` et relisent uniquement les champs publics connus, y compris dans les anciennes archives. Aucun serveur ni périphérique audio n'est lancé.

Un identifiant de session permet de relier les événements d'un même processus. Le panneau signale les sessions précédentes : une ancienne panne conservée après redémarrage ne décrit pas nécessairement l'état actuel. Si des écritures ont été perdues (saturation ou erreur disque), leur compteur est visible dans le panneau et dans le rapport exporté.

## Lire les événements

| Catégorie | Ce qu'elle permet de distinguer |
| --- | --- |
| `spotify` | Refus HTTP, limitation de requêtes, expiration/révocation d'autorisation ou délai réseau. |
| `ytdlp` | Échec ou délai d'extraction et résolution réussie d'une source. |
| `mpv` | Démarrage, sortie inattendue du moteur ou perte de communication IPC. |
| `player` | Lecture démarrée, absence de progression, nouvelle tentative ou abandon d'une piste. |
| `audio` | Routage virtuel prêt ou indisponible. |
| `server` | Démarrage/arrêt avec motif, connexions, déconnexions et commandes refusées ou échouées. |
| `queue` | Début, résultat ou annulation d'un import, nombre de titres et durée. |
| `providers` | Résolveur de secours employé ou échec de toutes les méthodes, avec plateforme et étape. |
| `cache` | Cache de correspondances indisponible en lecture ou en écriture. |
| `runtime` | Erreur non interceptée, promesse rejetée non gérée, avertissement Node.js et relevé périodique. |
| `tools` | État de vérification des exécutables. |

Les événements possèdent un horodatage, un code stable et, quand disponibles, le statut HTTP, le code de sortie du processus, le motif normalisé, le numéro de tentative et la durée. Le journal conserve des messages définis par l'application; il n'enregistre pas les messages bruts des fournisseurs, les cookies, les jetons, les titres ni les URL audio signées.

## Comprendre un arrêt

- `MPV_STREAM_FAILED` avec HTTP 403 : le flux a été refusé, par exemple après expiration d'une URL ou d'une session. Le lecteur extrait une autre source avant de réessayer.
- `MEDIA_RESOLUTION_FALLBACK` : une méthode a échoué, une autre est essayée. Ce message seul ne signifie pas que la piste est perdue; chercher la réussite ou l'échec qui suit.
- `SPOTIFY_REQUEST_FAILED` avec 429 : Spotify impose un quota. Le bot respecte le délai, y compris entre plusieurs ajouts; réessayer immédiatement ne provoque plus de nouvelles requêtes au service.
- `PLAYBACK_RETRY`, puis `PLAYBACK_RECOVERED` : la reprise a tenu au moins 30 secondes de progression réelle. Deux échecs rapprochés restent limités; une session longue récupérée retrouve ensuite une tentative de secours.
- `PROCESS_UNCAUGHT_EXCEPTION` ou `PROCESS_UNHANDLED_REJECTION` : une erreur fatale a demandé un arrêt avec code 1. Le bot tente d'enregistrer la cause et de fermer mpv avant de quitter, au plus tard après trois secondes.
- `SERVER_STOPPING` précise l'origine connue : signal, inactivité configurée ou erreur. Les commandes ne sont plus traitées pendant l'arrêt.

`RUNTIME_HEARTBEAT` est écrit au démarrage puis toutes les cinq minutes : durée d'activité, mémoire totale, mémoire JavaScript et retard du timer. `DIAGNOSTICS_HEARTBEAT_MS` ajuste cet intervalle entre 30 secondes et une heure. Le retard indique un manque de réactivité ou une suspension de la machine; il ne distingue pas à lui seul ces causes. Aucun log n'est produit à chaque mise à jour de progression audio.

Une panne du tunnel Cloudflare ne ferme plus l'application locale : le lanceur le relance avec un délai progressif de une à trente secondes. Ses sorties restent dans la console du lanceur. Une coupure du navigateur conserve les ajouts non confirmés jusqu'à leur confirmation ou leur expiration afin de limiter les doublons.

## Conservation

Le journal se trouve par défaut dans `.data/logs/events.ndjson`. Il est ignoré par Git et tourne sur trois fichiers d'environ 1 Mio chacun (`events.ndjson`, `.1`, `.2`). Les événements récents sont relus au démarrage, y compris après une dernière ligne tronquée par un arrêt brutal. Les écritures sont ordonnées et la file d'attente est bornée; une saturation ou une erreur disque ne bloque pas la lecture. Deux emplacements restent réservés aux causes fatales après une rafale d'événements ordinaires.

`DIAGNOSTICS_LOG_DIR` change le dossier, `DIAGNOSTICS_MAX_BYTES` la taille par fichier et `DIAGNOSTICS_ENABLED=false` désactive l'écriture sur disque. Dans ce dernier cas, les événements restent disponibles en mémoire jusqu'au redémarrage. Le journal ne garantit pas une durée fixe de conservation : celle-ci dépend du nombre d'événements. Un dossier différent doit être utilisé pour chaque instance de serveur.

L'API `GET /diagnostics` renvoie le même relevé public et ne lance aucune lecture. Le backend reste accessible avec l'option `VITE_API_BASE`, ou à l'adresse configurée par `VITE_SERVER_URL`; le développement local utilise le proxy Vite. La démo Vercel indique que ces outils ne sont disponibles que dans l'application locale.

`GET /metrics` fournit les 100 dernières mesures d'opérations du backend, avec leur durée et leur résultat. Ces mesures sont conservées uniquement en mémoire; elles complètent les événements persistants sans les remplacer.

Le cache `backend/.data/provider-match-cache.json` conserve les correspondances vers des pages publiques YouTube/SoundCloud entre les redémarrages, avec une validité de 24 heures par défaut. Il exclut les flux audio temporaires ou signés. Les variables `PLAYER_PROVIDER_MATCH_CACHE_PATH`, `PLAYER_PROVIDER_MATCH_CACHE_MAX` et `PLAYER_PROVIDER_MATCH_CACHE_TTL_MS` permettent d'ajuster le chemin, la taille et la durée de validité.

L'état de la file et l'historique musical restent en mémoire : ce journal conserve les incidents, pas une sauvegarde des morceaux. Une fréquence supposée de deux semaines ne peut être confirmée qu'en comparant les événements enregistrés aux dates des interruptions. Un arrêt forcé du système (SIGKILL, manque de mémoire, panne électrique) peut empêcher toute dernière écriture; le dernier relevé périodique et les journaux système restent alors les indices disponibles.

## Modules communs

`backend/src/queue.ts` centralise les mutations synchrones de file et d'historique; les transitions asynchrones et les annulations restent dans `player.ts`. `shared/contracts.d.ts` définit les contrats frontend/backend. `shared/playback.js` fournit l'horloge et le formatage utilisés par le serveur, le lecteur, l'interface et la démo. Les imports fonctionnent en développement Vite, avec le backend compilé et dans la démo CommonJS.
