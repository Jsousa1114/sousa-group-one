# Sousa Group One

Application Express / PostgreSQL, interface française en JavaScript natif.
Cette révision remplace les sauvegardes globales du prototype par des opérations
métier validées, transactionnelles et limitées aux droits de chaque compte.

## Installation

Node.js **22.13+** (24 recommandé), PostgreSQL, HTTPS en production.

```sh
npm ci
cp .env.example .env
# Renseigner les variables dans .env puis :
node --env-file=.env server.js
```

En hébergement, configurer les variables dans le service et utiliser `npm start`.
`npm start` ne charge pas automatiquement un fichier `.env`.

- `DATABASE_URL` : connexion PostgreSQL.
- `JWT_SECRET` : secret aléatoire de 32 caractères minimum ; ne jamais le committer.
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` : premier administrateur,
  mot de passe de 12 caractères minimum. Un compte existant n'est remplacé que
  s'il possède encore le mot de passe public de démonstration. Retirer ces deux
  variables après le premier démarrage réussi.
- `PGSSL=disable` : uniquement pour PostgreSQL local sans TLS. En production,
  la connexion reste chiffrée. Cette installation Render accepte le certificat
  interne auto-signé de PostgreSQL sans vérifier son autorité, conformément à
  l'autorisation donnée pour ce déploiement.
- `RTC_TURN_URLS`, `RTC_TURN_USERNAME`, `RTC_TURN_CREDENTIAL` :
  relais TURN/TURNS de production pour fiabiliser les appels WebRTC derrière
  les réseaux mobiles, NAT stricts et Wi-Fi d'entreprise.
- `OBJECT_STORAGE_*` : stockage S3-compatible (Cloudflare R2, AWS S3, etc.).
  Sans ces variables, les fichiers restent en PostgreSQL pour compatibilité ;
  en production, le stockage objet est recommandé et visible dans `/healthz`.
- `PORT` : 3000 par défaut.

## Mise à jour depuis le prototype

1. Faire une sauvegarde PostgreSQL complète avant déploiement (`pg_dump -Fc`),
   puis vérifier sa restauration dans une base de test.
2. Configurer le compte bootstrap avant le premier démarrage. Tous les comptes
   portant encore l'ancien mot de passe public sont désactivés par la migration.
3. Déployer le code, lancer le serveur : les colonnes et tables manquantes sont
   ajoutées, les données métier existantes ne sont pas effacées.
4. Dans **Comptes**, créer les accès ou utiliser **Modifier / relier** pour relier
   les comptes existants aux véritables fiches salariés / clients et à leur entreprise.
5. Vérifier les anciennes fiches sans entreprise : elles restent visibles aux
   gestionnaires du groupe mais ne sont pas exposées aux autres entreprises.
   Leur rattachement historique doit être vérifié avant toute migration manuelle.
6. Les anciens messages sans participants ne sont pas publiés automatiquement
   dans les nouvelles conversations. Ils restent conservés dans `app_state`.
   Les anciens compteurs de documents ne représentaient pas de fichiers réels.
7. Valider les accès client et salarié sur une préproduction avant ouverture.

L'ancien cache navigateur et l'ancien jeton sont supprimés au chargement. Les
utilisateurs doivent se reconnecter. Aucun mode hors ligne n'est annoncé.

## Parcours disponibles

- Comptes : création, association à une fiche, modification, désactivation,
  réinitialisation par l'administrateur et changement de mot de passe personnel.
- Pointage personnel : début, pause, reprise, fin ; durée calculée au serveur,
  enregistrement par salarié et chantier, validation individuelle et export CSV.
- Planning : création et suppression d'affectations, refus des chevauchements
  et absences approuvées, liste chronologique et export réel.
- Absences : demande, validation/refus RH, déduction des vacances une seule fois.
  Le calcul actuel exclut les samedis et dimanches. Les jours fériés, demi-journées
  et calendriers de temps partiel demandent une règle métier complémentaire :
  vérifier ces cas avant validation ; ce module n'est pas un moteur de paie.
- Projets : création, équipe, avancement, statut, documents et coûts des dépenses.
- Finance : documents à plusieurs lignes, calcul au centime, émission,
  acceptation du devis par son client, paiement partiel/complet et solde recalculé.
  L'acceptation en portail est horodatée ; aucune signature électronique qualifiée
  n'est revendiquée. TVA et remises sont calculées ligne par ligne au centime,
  avec taux choisi explicitement (0 % par défaut). Voir `FINANCE.md` pour le
  nouveau parcours devis → facture, les PDF et le QR bancaire.
- Documents : stockage S3-compatible en production avec métadonnées en PostgreSQL,
  et repli PostgreSQL si aucun stockage objet n'est configuré. PDF/JPEG/PNG/WebP/TXT,
  5 Mo par fichier, accès contrôlé au téléchargement. Documents de chantier privés
  par défaut ; partage client explicite par un responsable. Les fichiers sont
  téléchargés en pièces jointes, jamais exécutés comme HTML.
- Messagerie : destinataires existants autorisés, conversations séparées,
  aucun envoi d'e-mail externe. Actualisation toutes les 30 secondes au repos.
- Indicateurs : calculés sur les données accessibles ; les valeurs fictives ont
  été retirées. CSV protégé contre l'interprétation de formules saisies.
- Matériel, fournisseurs, véhicules, outils, maintenance : création et listes
  persistantes. Pas de commandes fournisseurs ni de notifications automatiques.

## Sécurité et persistance

L'API exige un utilisateur actif en base à chaque requête. Les droits reposent
sur le rôle, l'entreprise et les identifiants réellement liés au compte ; les
menus ne constituent pas une protection. Un client ne voit que ses dossiers et
les documents explicitement partagés. Un salarié ne reçoit que ses heures,
absences et chantiers affectés. Les messages sont réservés aux participants.

`GET /api/state` renvoie une projection filtrée. L'ancien `POST /api/state` est
refusé. Les modifications passent par `/api/state/command` ou une route dédiée,
avec une révision et un identifiant de requête. Les collections métier normalisées
dans `entity_records` sont la source de lecture canonique ; `app_state` est
conservé comme snapshot de compatibilité et compteur de révision pendant la
transition. Le serveur verrouille la révision dans une transaction : une vue
périmée reçoit HTTP 409 et le formulaire reste ouvert. Une répétition identique
après perte de réponse n'est pas réappliquée. Les nouvelles évolutions de schéma
passent par les fichiers SQL versionnés du dossier `migrations/`.

Les comptes de démonstration ne sont plus créés. Les sessions navigateur utilisent
des cookies Secure/HttpOnly ; les sessions sont révocables et les intégrations
peuvent conserver la compatibilité Bearer. L'API applique aussi une limitation
générale des requêtes. Pour plusieurs instances, une limitation partagée au proxy
ou via Redis reste préférable.

Les saisies HTML sont échappées et une CSP interdit les scripts intégrés. Les
fichiers serveur ne sont pas servis publiquement. Le journal serveur trace les
opérations confirmées ; les journaux historiques du prototype ne sont pas
considérés comme une piste d'audit fiable.

La double authentification TOTP est disponible avec secrets chiffrés au repos,
codes de secours à usage unique et Passkeys/WebAuthn. Les sauvegardes doivent être
configurées chez l'hébergeur : sauvegarder la base **entière**, conserver une copie
séparée et tester régulièrement une restauration. Lorsque le stockage objet est
activé, sa politique de versionnement/rétention doit être sauvegardée séparément.
Une exportation CSV n'est pas une sauvegarde complète.

`GET /healthz` vérifie PostgreSQL et expose aussi, sans révéler de secret,
`turnConfigured`, `objectStorageConfigured` et `p0ExternalReady`. Le workflow
GitHub `uptime.yml` contrôle déjà le site et la base toutes les heures.

## Tests

```sh
npm ci
npm test
```

- Tests métier : droits, heures/pauses, affectations, centimes, paiements,
  absences, acceptation des devis et séparation des dossiers.
- Tests HTTP : moteur PostgreSQL réel embarqué via PGlite, transactions,
  conflits, idempotence, migration, fichiers, comptes et révocation des sessions.
- Tests DOM (jsdom) : navigation des sept rôles avec base vide, formulaires,
  sauvegardes, conflits, affichage des centimes et échappement HTML.

PGlite sérialise les connexions de test ; il ne remplace pas une campagne de
charge sur le PostgreSQL de production. Le workflow `live-browser.yml` vérifie
automatiquement la production sur Chromium desktop/mobile. Si les secrets GitHub
`E2E_EMAIL` et `E2E_PASSWORD` sont définis pour un compte dédié à faibles droits,
il réalise aussi une vraie connexion et vérifie l'accès authentifié à l'état privé.
