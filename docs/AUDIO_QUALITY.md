# Obtenir le meilleur son avec le bot

Pour la musique, choisis **Équilibré** dans le lecteur. Ce profil conserve la stéréo et la dynamique sous le plafond du limiteur, sans égalisation ni compression permanente. `AUDIO_PROFILE=balanced` dans `backend/.env` le sélectionne au démarrage. Relance le backend après un changement de configuration.

Le profil **Xbox** reste un choix de compatibilité pour le chat vocal : il mélange les canaux en mono, filtre les extrêmes et compresse légèrement le signal. Il peut mieux convenir à ce trajet, mais ne préserve pas autant l'enregistrement original.

## Ce que fait le backend

- YouTube : le bot demande d'abord le meilleur flux audio seul, sans imposer un conteneur WebM ou M4A. Il essaie l'accès avec cookies puis l'accès public avant les sources MP4 de secours. Les reprises après HTTP 403 restent actives. Le classement dépend des formats réellement accessibles à yt-dlp. [Sélection et classement yt-dlp](https://github.com/yt-dlp/yt-dlp#format-selection).
- mpv : décodage en flottant, sortie stéréo à 48 kHz et rééchantillonnage configuré. La configuration personnelle de mpv est ignorée pour conserver les réglages du bot. [Manuel mpv](https://mpv.io/manual/stable/).
- Profil Équilibré : plafond des échantillons à environ −1 dBFS avant le volume de sortie de 90 %. Le gain automatique du limiteur est désactivé; son tampon est vidé en fin de piste. Il s'agit d'un plafond des échantillons, pas d'une garantie sur les pics reconstruits après un encodage avec pertes. [Limiteur FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#alimiter).
- Linux : les nouveaux sinks virtuels sont créés en flottant 32 bits, stéréo, 48 kHz pour éviter une conversion intermédiaire en entier 16 bits. Les sinks déjà présents conservent leur format. [Module null-sink PulseAudio](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/#module-null-sink).
- Une entrée nommée **Music-Bot-Stereo** (`xmbot_input`) reprend les deux canaux du sink sans remix. Le backend la recrée au démarrage si nécessaire, car certains clients masquent les monitors dans leur liste de micros. Si sa création échoue, le monitor reste disponible comme solution de repli.

Une source déjà compressée ou saturée ne redevient pas sans pertes grâce à ces réglages. Les liens Spotify servent à rechercher un enregistrement jouable : le son provient alors de la source trouvée, pas du flux Spotify original. Un fichier FLAC/WAV original accessible directement au bot évite cette recherche et la compression de la source, mais le chat vocal peut encore réencoder le signal.

## Réglages Discord pour une entrée musicale dédiée

1. Sélectionne explicitement l'entrée virtuelle du bot : la sortie VoiceMeeter correspondant à **B2** sous Windows, ou **Music-Bot-Stereo** sous Linux. Sélectionne séparément le casque ou les haut-parleurs physiques pour la sortie de Discord : les voix reçues suivent ainsi une autre route que la musique transmise.
2. Choisis le profil d'entrée **Studio**, prévu pour une entrée sans traitement, ou configure le profil personnalisé avec **Krisp / suppression du bruit**, **annulation d'écho** et **contrôle automatique du gain** désactivés. C'est une recommandation de fidélité déduite de la fonction de ces traitements. Le fabricant Focusrite recommande aussi Studio pour les instruments. [Guide Focusrite](https://support.focusrite.com/hc/en-gb/articles/37822488093202-How-to-set-up-a-Focusrite-interface-in-Discord), [traitements vocaux Discord](https://github.com/discord/discord-api-docs/blob/main/developers/discord-social-sdk/development-guides/managing-voice-chat.mdx).
3. Si l'activation vocale coupe les passages calmes, désactive la sensibilité automatique et abaisse son seuil jusqu'à transmettre ces passages.
4. Dans les paramètres du salon vocal, choisis le meilleur débit disponible compatible avec les connexions des participants. Le plafond dépend du serveur; le bot ne contrôle pas ce réglage. [Débit audio Discord](https://support.discord.com/hc/en-us/articles/11635925354775-Audio-Bitrate-FAQ).
5. Compare à volume perçu égal, en écoutant depuis un autre appareil ou un autre participant : une écoute locale seule ne mesure pas ce qui arrive après Discord.

La stéréo est conservée à la sortie du bot en mode Équilibré. Sur le client Discord Linux testé le 11 novembre 2026, sélectionner Music-Bot-Stereo et Studio a fait passer la capture réelle de `s16le 1ch 48000Hz` à `s16le 2ch 48000Hz`. Ce constat vérifie l'entrée du client installé; la conservation de deux canaux distincts jusqu'aux auditeurs doit encore être vérifiée à la réception.

Sur le trajet vocal Xbox testé ensuite, l'utilisateur a entendu les deux séries gauche/droite dans le seul écouteur gauche, alors que la capture locale séparait strictement les canaux et que la sortie mono Xbox était désactivée. Ce résultat établit un mélange après la sortie locale du bot, sans identifier à lui seul l'encodage Discord ou le traitement de réception responsable.

Un partage **Go Live de l'application mpv** constitue un autre trajet à tester. La Xbox peut ouvrir ce partage depuis les participants du salon, le profil de l'émetteur puis **Regarder le stream**. L'affichage est en plein écran; son usage pendant un jeu reste à vérifier. Pendant cet essai, couper la voie micro musicale du compte émetteur permet d'écouter uniquement le son du partage. La séparation gauche/droite reçue doit être contrôlée sur ce nouveau trajet également. [FAQ officielle Discord/Xbox](https://support.discord.com/hc/en-us/articles/360003953831-Discord-and-Xbox-Connection-FAQ).

## VoiceMeeter / Windows

Configure une fréquence cohérente de **48 000 Hz** pour le moteur VoiceMeeter et les périphériques virtuels utilisés. Garde les gains de la tranche musicale et du bus B2 à **0 dB**, avec les traitements, l'égalisation et le mono désactivés pour le profil Équilibré. Contrôle les indicateurs de niveau pendant un passage fort; réduis un gain si le mix complet sature. Le backend configure les routes et le gain de ses tranches, mais ne réinitialise pas le mixeur personnel.

## Linux

Pour inspecter le format du sink existant :

```bash
pactl list short sinks
pactl list short sources
```

Une nouvelle route créée par le bot doit afficher `float32le 2ch 48000Hz` côté PulseAudio. Un sink existant en `s16le` reste utilisable; un redémarrage du backend seul ne change pas son format. Pour bénéficier du nouveau format, recrée uniquement le sink du bot pendant un arrêt de la lecture, ou redémarre la session audio puis le bot.

`LINUX_VIRTUAL_SOURCE_NAME` permet de personnaliser le nom technique de l'entrée, `xmbot_input` par défaut. L'alias suit le monitor du sink configuré et les réglages d'une entrée déjà présente sont conservés. Si l'alias est indisponible et que Discord masque le monitor, définis le monitor comme entrée système par défaut puis sélectionne « Par défaut » dans Discord.

Pour vérifier les canaux réellement demandés par les applications :

```bash
pactl list short source-outputs
```

La ligne Discord doit afficher deux canaux (`2ch`). Un test alternant gauche seule puis droite seule, reçu sur un autre appareil avec un casque, permet ensuite de vérifier qu'il ne s'agit pas de mono dupliqué.

## Vérifier les changements

Depuis la racine :

```bash
npm test
npm run build
npm run lint
```

Les tests `backend/test/audio-quality.test.ts` utilisent le vrai mpv pour rendre des signaux synthétiques dans des fichiers temporaires, sans périphérique audio ni réseau. Ils vérifient la séparation des canaux, l'absence de gain sur un signal sous le plafond, les pics surchargés et la conservation des derniers échantillons. Ils vérifient aussi que le profil Xbox rend toujours un signal mono fini et limité. Ils sont ignorés si mpv n'est pas installé.

Les tests d'extraction et de routage couvrent le choix audio avant MP4, les cookies refusés, le repli compatible et la création/réutilisation du sink virtuel. Ces contrôles ne remplacent pas une écoute dans un vrai salon Discord ou Xbox.

## Refaire un test gauche/droite sur le lecteur actif

Sur Linux, depuis la racine du projet :

```bash
npm run check:stereo
npm run check:stereo -- --dry-run
npm run check:stereo -- --prepare-stream
npm run check:stereo -- --play
```

La commande sans option affiche l'aide. `--dry-run` identifie le lecteur par son PID, son socket et sa route Pulse, sans jouer ni changer de réglage. `--prepare-stream` ouvre uniquement la fenêtre du lecteur pour un éventuel partage d'application; le partage reste une action distincte dans Discord.

`--play` remplace temporairement le son du lecteur actif par quatre bips à gauche, puis quatre identiques à droite, pendant 16,5 secondes. Les filtres musicaux sont ensuite restaurés, y compris lors d'une interruption ou d'une erreur si le lecteur reste joignable. Garde la piste et le profil inchangés pendant le test. L'outil détecte les erreurs de négociation du filtre : une commande acceptée par mpv ne prouve pas, à elle seule, que les bips ont été produits. Le signal est également vérifié hors ligne avec le vrai mpv à 44,1 et 48 kHz.

Pour vérifier la réception, garde les deux écouteurs branchés et porte seulement le gauche : seule la première série doit être audible. Avec le droit seul, seule la deuxième doit l'être. Écouter les deux séries dans le même écouteur indique un mélange des canaux sur le trajet testé.

## Streams sans son sur Xbox

Le 12 novembre 2026, l'utilisateur a signalé que les streams étaient muets sur sa Xbox alors qu'un autre participant entendait celui du bot. Le contrôle côté émetteur a confirmé que « Partager l'audio du stream » était activé et que le lecteur produisait un signal non silencieux, sans saturation. L'écoute via le vocal a été rétablie en attendant de résoudre la réception du partage.

Dans le lecteur du stream, vérifie son réglage **Muet / Volume du stream**, distinct du volume vocal. Quitter puis rouvrir le visionnage constitue un essai de reconnexion. Si le problème touche aussi les autres streams, vérifie les mises à jour système et redémarre la console lorsque tu peux interrompre ta session. Ces étapes ne garantissent pas une correction; aucun défaut général de Discord Xbox n'est établi par les tests locaux. [Contrôles Go Live](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share), [FAQ Discord/Xbox](https://support.discord.com/hc/en-us/articles/360003953831-Discord-and-Xbox-Connection-FAQ), [guide de dépannage](https://support.discord.com/hc/en-us/articles/33030151293079-Discord-Voice-Video-Streaming-Guide).

Après une mise à jour et un redémarrage de la Xbox, le nouvel essai du 12 novembre a rétabli le son du stream. Le test corrigé a ensuite été validé à la réception : seule la première série arrivait dans l'écouteur gauche; le second essai avec le droit a également été confirmé par l'utilisateur. La capture isolée du lecteur partagé a vérifié les mêmes canaux, puis les filtres musicaux ont été restaurés.

Le trajet validé pour la stéréo sur cette installation est donc **mpv → partage Go Live de l'application avec son audio → Regarder le stream sur Xbox**. La voie micro musicale du compte émetteur reste coupée pendant ce partage pour éviter les doublons. Cette validation concerne Go Live; le chemin vocal testé auparavant mélangeait les canaux à la réception.
