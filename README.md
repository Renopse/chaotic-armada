# Chaotic Armada (version en ligne)

Version jouable dans le navigateur du jeu de cartes **Chaotic Armada**, pour 3 ou 4 joueurs.

- **Contre des bots** : « Jouer contre des bots ».
- **Entre amis** : « Créer une partie en ligne », puis envoyez le lien affiché. Les invités n'ont besoin d'aucun compte. Les places libres sont prises par des bots.

## Fonctionnement

- Site 100 % statique (GitHub Pages), sans serveur à maintenir.
- Le multijoueur est pair à pair (WebRTC via [PeerJS](https://peerjs.com)) : **l'onglet de la personne qui crée la partie fait tourner le jeu** et doit rester ouvert.
- Un invité déconnecté est remplacé par un bot au bout d'environ 30 secondes. S'il recharge la page du lien, il retrouve sa place.

## Fichiers

- `js/cards.js` : données des 144 cartes (coûts, Force, positions de placement, textes).
- `js/engine.js` : moteur de règles.
- `js/bot.js` : IA des bots (simulation de chaque coup possible).
- `js/net.js`, `js/app.js` : réseau et interface.
- `tests/fuzz.mjs` : enchaîne des parties de bots pour détecter les erreurs (`node tests/fuzz.mjs 100`).

## Choix d'interprétation des règles

- Effets sans éclair = permanents (Mentor : effet immédiat).
- « Adjacent » = positions voisines sur le navire ; les Pirates légendaires comptent comme pirates du bateau, mais ne sont pas adjacents et ne sont pas visés par les effets de défausse.
- « Jouer une carte / un pirate » = Action jouée ou pirate recruté face visible (ou révélé avant le combat), seuils calculés sur le coût réellement payé.
- Matelot maladroit / Moussaillon incompétent : le pirate qui les **remplace** coûte 5 / 3 or de moins.
- Esquive : proposée automatiquement quand un effet adverse nuisible vous vise.
- Guarda Costa, vol et échange de pirates : l'effet de placement de la nouvelle position se déclenche.
- Vétéran et l'Action « 2 or par pirate bien placé » : les autres joueurs gagnent selon le nombre de pirates bien placés de celui qui joue la carte.
