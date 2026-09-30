# Finalisation du 30 septembre 2026

## Intégré

- Centre Pro issu de `009e1ab` : chantier central, CRM, planning multi-ressources,
  permissions, corbeille, signatures et messagerie.
- Fichiers d'interface versionnés ; priorité au réseau pour JS/CSS dans le
  service worker, repli hors ligne conservé ; fichiers Pro précachés.
- Configuration TOTP refusée lorsque la double authentification est active ;
  mise à jour conditionnelle et transactionnelle ; chiffrement exigé en production.
- Récurrences des bons de travail : transaction, verrouillage des échéances,
  unicité par occurrence, fin de mois et heure locale suisse conservées.
- Les indicateurs des intégrations distinguent paramètres présents et connexion
  réellement vérifiée. Stockage : les quatre paramètres sont requis.

L'ancien brouillon `sousa-completion` n'a pas été fusionné en bloc : il précède
les modules P1/P2/Pro et possède des modèles de stock concurrents. Les corrections
ci-dessus ont été reprises sélectivement, avec tests. Les autres différences ne
constituent pas une liste de fonctionnalités manquantes validée.

## Bloqué par une configuration ou une décision externe

La dernière vérification Render du 30 septembre confirme une base gratuite
expirant le **14 octobre 2026**, sans stockage objet ni TURN configurés.

1. Choisir une base PostgreSQL durable et autoriser le budget. Sauvegarder puis
   restaurer dans une base séparée avant toute bascule de production.
2. Fournir/configurer un stockage S3 compatible (endpoint, bucket, identifiants
   limités au bucket) et vérifier sauvegarde, téléchargement et restauration.
3. Fournir/configurer TURN puis tester deux appareils sur deux réseaux distincts.
4. Choisir les services réellement souhaités (banque/comptabilité, e-mail/SMS,
   calendriers) et leurs comptes/API. Les formulaires de paramètres ne prouvent
   pas la présence d'un connecteur complet ni son bon fonctionnement.
5. Configurer le fournisseur IA/OCR et tester des documents non sensibles avant
   usage réel. Ne pas saisir les secrets dans les conversations ou dans Git.

## Validation encore nécessaire

- Vérification visuelle authentifiée du déploiement et parcours réels autorisés.
- Parcours prospect → devis → chantier → heures/matériel → facture → paiement.
- Tests terrain appels, hors-ligne et conflits sur téléphones réels.
- Traductions complètes, règles RH particulières et audit d'accessibilité.
- Activation éventuelle du mode canonique des données uniquement après sauvegarde
  vérifiée et restauration de test. Ne pas activer pour faire disparaître un voyant.

Les tests automatisés et un déploiement réussi ne constituent pas une certification
globale du cahier des charges P0–P3. Aucun abonnement ni migration destructive de
production n'est autorisé ou exécuté par cette livraison.
