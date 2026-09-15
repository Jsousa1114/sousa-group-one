# Sousa Group One — Backend

Petite API Express + PostgreSQL qui sert le frontend existant (fichiers à la
racine du dépôt) et lui donne une vraie persistance : tant que le serveur tourne, les données
sont sauvegardées dans une vraie base de données et partagées entre tous les
utilisateurs et appareils.

## Comment ça marche

Plutôt que de recréer une table par module (ce qui aurait demandé de réécrire
en profondeur les 30+ modules du frontend, avec un vrai risque de tout casser
sans pouvoir tester en conditions réelles), l'API expose deux choses simples :

- `POST /api/auth/login` — vraie authentification (email + mot de passe
  vérifiés côté serveur, avec un jeton de session).
- `GET/POST /api/state` — lit/écrit l'intégralité des données de l'app
  (salariés, chantiers, devis, factures, planning, absences, messages, etc.)
  comme un seul document JSON, dans la table `app_state`.

Le frontend n'a presque pas changé : ses fonctions `load()`/`save()`
utilisées partout dans le code continuent de fonctionner à l'identique,
elles synchronisent juste maintenant avec le serveur en plus du cache local.

**Compromis assumé** : ce n'est pas encore le schéma relationnel complet de
`DATABASE_SCHEMA.sql` (tables séparées par module, requêtes SQL fines,
rapports croisés). C'est une vraie base de données, avec une vraie
authentification, qui couvre TOUS les modules dès aujourd'hui — la
modélisation relationnelle complète peut venir ensuite, module par module.

## Comptes de démonstration

Créés automatiquement au premier démarrage (mot de passe unique : `demo1234`) :

| Rôle | Email |
|---|---|
| Administrateur groupe | admin@sousagroup.ch |
| Direction | direction@sousagroup.ch |
| RH | hr@sousagroup.ch |
| Responsable chantier | manager@sousagroup.ch |
| Comptabilité | accounting@sousagroup.ch |
| Salarié | employee@sousagroup.ch |
| Client | client@sousagroup.ch |

Changez ces mots de passe une fois en production réelle (via un futur
endpoint d'administration, ou directement en base).

## Lancer en local

```bash
cp .env.example .env
# éditez .env avec l'URL d'une base Postgres locale ou distante
npm install
npm start
```

Puis ouvrez `http://localhost:3000`.

## Déployer sur Render

1. Poussez ce dossier sur un dépôt GitHub (voir instructions fournies à côté).
2. Sur Render : créez un **Web Service** pointant vers ce dépôt.
   - Build command : `npm install`
   - Start command : `npm start`
3. Créez une base **PostgreSQL** sur Render (ou réutilisez-en une existante).
4. Dans les variables d'environnement du service, définissez :
   - `DATABASE_URL` → l'URL interne de la base Postgres Render
   - `JWT_SECRET` → une chaîne aléatoire longue

C'est tout — le serveur crée les tables et les comptes de démonstration
tout seul au premier démarrage.
