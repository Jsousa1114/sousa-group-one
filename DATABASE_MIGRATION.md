# Migration PostgreSQL production

La base Render gratuite actuelle expire le **14 octobre 2026**.

## Sauvegarde vérifiée

```bash
DATABASE_URL='postgres://...' bash scripts/backup-db.sh
```

Le script crée un dump PostgreSQL au format custom et vérifie immédiatement qu'il est lisible par `pg_restore`.

## Migration vers une nouvelle base

Créer d'abord une base PostgreSQL persistante, puis :

```bash
SOURCE_DATABASE_URL='postgres://ancienne...' \
TARGET_DATABASE_URL='postgres://nouvelle...' \
bash scripts/migrate-db.sh
```

Le script :
1. sauvegarde la source ;
2. valide le dump ;
3. restaure la cible ;
4. vérifie PostgreSQL, la table `users` et la révision `app_state`.

Après cela, exécuter tous les tests navigateur sur la cible avant de remplacer `DATABASE_URL` dans Render.

## Sauvegardes automatiques

Pour la production, activer les sauvegardes gérées du fournisseur PostgreSQL **ou** envoyer les dumps chiffrés vers un stockage objet privé. Ne conserver aucun dump dans le dépôt Git.
