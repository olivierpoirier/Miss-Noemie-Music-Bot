# Audit du Music Bot — 15 octobre 2026

Le problème principal est le cycle de vie du bot. Avant correction, une simple déconnexion de tous les navigateurs provoquait son arrêt définitif après 60 secondes. D'autres erreurs pouvaient laisser une file bloquée alors que le serveur répondait encore. Ces défauts sont distincts des refus de Spotify ou de YouTube.

Périmètre : backend TypeScript, lecteur et IPC mpv, résolution Spotify/yt-dlp/play-dl, détection des plateformes, frontend React, démo Vercel, lanceur et dépendances npm. Les secrets et cookies locaux n'ont pas été consultés. Le fichier cookies déjà modifié et la vidéo locale déjà présente ont été conservés.

## Défauts corrigés

| Priorité | Défaut et effet observable | Correction et emplacement |
| --- | --- | --- |
| Haute | Arrêt du serveur une minute après le dernier client : fermeture d'onglet, veille mobile ou tunnel interrompu. | Arrêt automatique désactivé par défaut, option `IDLE_SHUTDOWN_MS` conservée, reconnexion annulant le délai. [server.ts](../backend/src/server.ts), [config.ts](../backend/src/config.ts). |
| Haute | Rejets de commandes asynchrones et données Socket.IO invalides pouvant arrêter Node.js. | Gestion commune des erreurs, validation des messages et sérialisation des commandes modifiant la lecture. [server.ts](../backend/src/server.ts). |
| Haute | Erreurs de socket mpv non écoutées, écritures considérées réussies sans réponse, attentes restant pendantes après fermeture. | Accusés de réception IPC, délais, rejet des opérations en attente et arrêt du transport défaillant. [mpv.ts](../backend/src/mpv.ts). |
| Haute | Sortie de mpv laissant la file immobile, démarrages concurrents, fin de piste reçue pendant une résolution et perdue. | Démarrage partagé, identité du moteur vérifiée, demandes de poursuite mémorisées et reprise limitée à une tentative par piste. [player.ts](../backend/src/player.ts). |
| Haute | Résolution encore en cours après « passer » ou « vider » : une ancienne piste pouvait repartir ou un ajout réapparaître. | Générations d'opérations, annulation de l'attente active et invalidation des ajouts antérieurs au vidage. [player.ts](../backend/src/player.ts), [server.ts](../backend/src/server.ts), [demo.js](../api/demo.js). |
| Haute | Spotify sans délai réseau, rafraîchissements de jeton concurrents et aucun renouvellement après un HTTP 401. | Délais couvrant aussi le corps HTTP, tentatives bornées sur réseau/429/5xx, renouvellement partagé et nouvelle authentification après 401. [spotify.ts](../backend/src/spotify.ts). |
| Haute | Appel Spotify `/items?limit=100`, incompatible avec la limite documentée de 50. | Pagination de 50, import borné à 200 entrées examinées, messages explicites pour les refus d'accès. [spotify.ts](../backend/src/spotify.ts). |
| Haute | Sources préchargées périmées ou réutilisées après erreur HTTP 403; appels play-dl pouvant attendre indéfiniment. | Expiration des URL signées, invalidation avant nouvelle tentative, résolutions partagées et délais sur les appels de secours. [ytdlp.ts](../backend/src/ytdlp.ts), [player.ts](../backend/src/player.ts). |
| Haute | Réponse yt-dlp avec formats séparés choisissant parfois la vidéo sans audio. | Sélection explicite du flux audio avant utilisation par mpv. [ytdlp.ts](../backend/src/ytdlp.ts). |
| Moyenne | Routage Linux annoncé prêt sans vraie source `.monitor`; désactiver sa création rendait même un sink préexistant inutilisable. | Vérification du sink et de sa source, acceptation d'un sink créé manuellement, réessai du routage et commandes système bornées. [utils.ts](../backend/src/utils.ts). |
| Moyenne | Ressources VoiceMeeter conservées après erreur, paramètres appliqués sans attendre et échec de lancement non géré. | Déconnexion en `finally`, attente des réglages et gestion des erreurs de processus. [utils.ts](../backend/src/utils.ts). |
| Moyenne | Perte de position lors de la pause, ancien morceau restant actif sur « précédent », ordre de file pouvant dupliquer une entrée. | Horloge calculée avant la pause, arrêt du bon moteur, identifiants de réorganisation uniques. [server.ts](../backend/src/server.ts), [player.ts](../backend/src/player.ts). |
| Moyenne | Accumulation des entrées terminées dans la file pendant de longues sessions. | Suppression de la file de travail; historique limité à 200 instantanés conservé. [server.ts](../backend/src/server.ts). |
| Moyenne | Connexion WebSocket seule, peu de retour sur les pertes de connexion et les ajouts refusés. | Repli polling, reconnexion et erreurs visibles, réponse `play_result` liée à chaque demande. [useLiveQueue.ts](../frontend/src/hooks/useLiveQueue.ts). |
| Moyenne | Démo : vidage en GET refusé, corps HTTP sans délai, réponses de polling anciennes écrasant les actions récentes. | Méthodes cohérentes, requêtes annulables et bornées, mutations ordonnées et réponses périmées ignorées. [useVercelDemoQueue.ts](../frontend/src/hooks/useVercelDemoQueue.ts), [demo-api.ts](../frontend/src/lib/demo-api.ts). |
| Moyenne | Double réajout par glisser-déposer, poignée de réorganisation inactive, seek mobile/clavier non appliqué, recherche textuelle tronquée au premier mot. | Correction des événements, de la soumission et de la validation des contrôles. [QueueList.tsx](../frontend/src/components/QueueList.tsx), [PlayerBar.tsx](../frontend/src/components/PlayerBar.tsx), [App.tsx](../frontend/src/App.tsx). |
| Moyenne | Lanceur laissant des descendants actifs et des ports occupés; sortie normale d'un service ignorée. | Arrêt des groupes de processus, gestion de toute sortie, vraie vérification HTTP et port backend configurable. [dev.mjs](../scripts/dev.mjs). |

## Simplifications et compatibilité

Le cycle de vie des notifications et des indicateurs d'attente est commun aux deux transports dans `useQueueFeedback`. L'initialisation Spotify de play-dl, devenue redondante avec le résolveur Spotify dédié, a été retirée. L'ancienne configuration ESLint Next.js à la racine, sans dépendances Next.js correspondantes, a été supprimée; `npm run lint` lance la configuration React existante.

YouTube, Spotify, SoundCloud, Twitch, liens directs, recherche, playlists, groupes, aléatoire, repeat, précédent, seek, historique, préchargement, profils balanced/xbox, thèmes, routage virtuel, tunnel et démo restent présents. Le build local et le build Vercel conservent leurs dossiers séparés.

Les contrôles rejettent désormais les données incohérentes. Une panne de flux provoque au maximum une relance de la piste depuis le début, puis un passage à la suivante. Un blocage sans progression est détecté après environ 60 secondes hors pause. Cette reprise limitée évite une boucle infinie sur un lien définitivement inaccessible.

## Dépendances

Les correctifs npm compatibles avec les versions déclarées ont été appliqués, sans migration majeure forcée et sans exécuter de scripts d'installation.

- Backend : 9 alertes de production avant correction, aucune après mise à jour compatible. Les dépendances concernées incluaient Express, Engine.IO, le parseur Socket.IO et ws.
- Frontend et outils : 31 alertes avant correction, 7 restantes après mise à jour compatible (5 hautes, 2 modérées), liées aux dépendances de développement de Tailwind CSS 3 (`braces`, `postcss-selector-parser` et leurs parents).
- Frontend en production (`npm audit --omit=dev`) : aucune alerte après mise à jour.
- La proposition automatique npm restante impose Tailwind CSS 4. Cette migration change la chaîne CSS et demande une vérification visuelle des thèmes; elle n'a pas été appliquée pendant la correction de stabilité. Les alertes ne prouvent pas à elles seules qu'une vulnérabilité est exploitable dans les chemins utilisés par ce projet.

## Limites à connaître

- **Spotify** : la documentation actuelle limite l'accès aux éléments d'une playlist aux propriétaires ou collaborateurs et peut répondre 403. Une page Spotify publique ne garantit donc pas l'accès API avec les seuls identifiants de l'application. Les métadonnées Spotify sont ensuite recherchées sur YouTube : l'audio reste dépendant de cette seconde plateforme. [Documentation Spotify](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).
- **Cookies** : depuis la fusion, les fichiers cookies locaux sont ignorés et aucun n'est suivi dans la version actuelle. Les copies locales sont conservées; l'historique Git antérieur n'a pas été réécrit.
- **Contrôle partagé** : le bot reste un contrôleur partagé sans authentification. Toute personne ayant accès à son adresse peut utiliser ses commandes. Le tunnel doit rester limité au groupe auquel tu souhaites donner ce contrôle.
- **Persistance** : file et historique restent en mémoire, comme avant. Un redémarrage complet du serveur les efface. La démo Vercel possède aussi un état mémoire dépendant de l'instance qui répond.
- **Appels de secours** : un délai JavaScript libère l'attente d'un appel play-dl, mais cette bibliothèque ne permet pas nécessairement d'annuler sa requête sous-jacente.
- **Validation réelle** : les tests automatisés emploient de faux services et périphériques. Ils n'établissent pas le bon fonctionnement des identifiants Spotify locaux, d'une session YouTube réelle, de VoiceMeeter sous Windows ou d'une écoute Xbox prolongée. Le fichier vidéo local ne permet pas à lui seul d'attribuer un téléchargement au bot; les commandes JSON yt-dlp utilisées simulent normalement l'extraction. [Options officielles yt-dlp](https://github.com/yt-dlp/yt-dlp#usage-and-options).

## Vérification et diagnostic

Les commandes suivantes sont disponibles depuis la racine :

```bash
npm test
npm run lint
npm run build
npm run build:frontend:vercel
node scripts/dev.mjs --check
```

Les tests couvrent les échecs et l'expiration de Spotify, la pagination, la résolution et le cache yt-dlp, les erreurs IPC mpv, les courses du lecteur, les messages Socket.IO invalides, la reconnexion, le routage virtuel, le contrat HTTP de la démo, les requêtes lentes et les horloges de lecture.

Résultat final : **47 tests réussis** (36 backend, 11 frontend), sans échec ni test ignoré sur cet environnement Linux. Compilation backend, builds frontend local et Vercel, ESLint et vérifications du lanceur réussis. Les deux profils audio ont aussi été exécutés avec le vrai mpv 0.37.0, une source synthétique et `--ao=null` : sortie correcte, sans lecture sur les haut-parleurs. Le lanceur a été vérifié avec des serveurs factices pour confirmer la propagation du port et l'arrêt des descendants.

Pour diagnostiquer une nouvelle interruption, comparer `GET /health` avec les logs `[player]`, `[mpv]`, `[spotify]` et `[socket:...]`. Le champ `audioRouting` distingue une entrée virtuelle absente d'un serveur déconnecté; `playing` et `queued` indiquent si la file continue. `PORT` vaut 4000 par défaut, `IDLE_SHUTDOWN_MS=0` conserve le bot actif et `SPOTIFY_MARKET=CA` sélectionne le catalogue canadien.

## Améliorations ajoutées après l'audit

Les mutations de file et d'historique sont centralisées dans `backend/src/queue.ts`. Le serveur utilise une seule séquence de finalisation des ajouts. Les types frontend/backend et ceux du diagnostic sont définis dans `shared/contracts.d.ts`; l'horloge est partagée via `shared/playback.js`, y compris avec la démo CommonJS et le serveur compilé.

Le journal persistant à rotation conserve des événements structurés et un historique borné au redémarrage. Les messages proviennent d'un catalogue fixe : cookies, jetons, titres et URL de flux ne sont pas enregistrés. Les erreurs disque sont contenues, les files d'écriture bornées et une dernière ligne tronquée ne fait pas perdre le premier nouvel événement.

Le panneau **Diagnostic du bot** affiche l'état du serveur, du lecteur et du routage, les versions et chemins réels des outils, les événements récents et un export JSON filtré. Il cesse de consulter le serveur lorsqu'il est fermé ou que l'onglet est invisible. L'alerte audio permet d'y accéder sans autoriser la lecture sur la sortie système. Les commandes `npm run doctor` et `npm run update:ytdlp` ciblent la copie effectivement configurée; la mise à jour reste une opération explicite.

Validation de cette étape : **83 tests réussis** (64 backend, 19 frontend), compilation backend, builds local/Vercel et lint réussis. Chrome a aussi vérifié le développement Vite avec les modules ESM partagés, l'accès au diagnostic malgré une panne audio simulée, l'affichage de la version et de son avertissement, l'absence de débordement mobile, l'arrêt du polling à la fermeture et l'absence d'erreurs JavaScript non traitées. Les services audio de ces scénarios sont simulés; les identifiants privés n'ont pas été utilisés. Le contrôle local a confirmé yt-dlp `2026.03.17` et mpv `0.37.0`; yt-dlp est signalé comme ancien et n'a pas été mis à jour automatiquement.

Le [guide de diagnostic](DIAGNOSTICS.md) décrit les commandes, les champs et la conservation des journaux.


## Vérification complémentaire des interruptions et des logs

Cette vérification complète les étapes historiques ci-dessus. Les pannes suivantes ont été reproduites par des tests isolés puis corrigées :

| Défaut | Comportement corrigé |
| --- | --- |
| Sortie du tunnel Cloudflare traitée comme une panne de toute l'application | Backend et musique restent actifs; relance du tunnel avec délai progressif borné. |
| mpv signale un fichier chargé puis s'arrête; événements tardifs trompeurs | Démarrage invalidé, reprise immédiate et anciens événements ignorés. |
| Une seule reprise disponible pendant toute la durée d'un flux long | Budget réarmé après 30 secondes de progression effective, avec échecs rapprochés toujours bornés. |
| Recherche YouTube de secours conservant parfois le flux signé | Conservation de la page vidéo stable; nouveau flux extrait au moment de la lecture. |
| Source déjà expirée renvoyée à mpv | Rejet avant lecture, puis stratégie suivante. |
| Délais JavaScript laissant s'accumuler les appels play-dl non annulables | Trois opérations réelles au maximum, puis repli yt-dlp avec processus arrêtables. |
| Nouveaux ajouts Spotify ignorant le délai de quota d'une requête précédente | Délai mémorisé par service, formats secondes/date HTTP pris en compte. |
| Déconnexion du navigateur débloquant un import encore actif | Confirmation attendue après reconnexion et verrou borné à cinq minutes. |
| Déconnexion explicite Socket.IO sans reconnexion automatique | Nouvelle connexion programmée et annulée correctement au démontage. |
| Causes d'échec visibles seulement dans la console ou remplacées par une erreur générique | Événements persistants avec codes, motifs normalisés, plateforme, étape et durée. |

Les journaux portent un identifiant de session, conservent une place pour les erreurs fatales même après saturation et exposent les écritures perdues. Un relevé de mémoire et de réactivité est enregistré au démarrage puis toutes les cinq minutes. Les commandes `npm run logs` et `npm run logs -- --follow` relisent un historique filtré; les sorties du tunnel restent dans la console du lanceur.

L'audit des dépendances de production du backend et du frontend ne signale aucune vulnérabilité. Aucune migration majeure de dépendance n'a été nécessaire pour ces corrections.

Ces tests ne prouvent pas une cause unique pour les interruptions observées toutes les deux semaines. Les cookies, autorisations ou quotas des plateformes, leur disponibilité et le routage audio du système restent des dépendances externes. Un arrêt système brutal peut empêcher la dernière écriture. Les requêtes play-dl déjà bloquées ne sont pas annulables par cette bibliothèque, mais leur nombre est désormais plafonné.


Validation de cette vérification : **136 tests réussis** (112 backend, 24 frontend), aucun échec ni test ignoré. Compilation backend, builds local/Vercel et lint réussis. Les tests d'erreur fatale utilisent de vrais processus Node isolés; les tests audio, fournisseurs et tunnel utilisent des services simulés sans identifiants privés. Les exécutables installés ont été vérifiés sans lecture audio : yt-dlp `2026.08.19`, mpv `0.37.0`.

Chrome a également validé les nouveaux événements de mémoire et de session, leur affichage mobile sans débordement, l'accès malgré une panne audio simulée, l'arrêt des consultations à la fermeture du panneau et l'absence d'erreurs JavaScript non traitées.
