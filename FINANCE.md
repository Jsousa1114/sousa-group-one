# Devis et factures

## Modèle de présentation

Le modèle reprend la facture de référence fournie : logo Home Service,
titre en haut à droite, coordonnées, dates, objet détaillé, tableau à quatre
colonnes, détails de prestation, exclusions/options, conditions, totaux et
pagination. Les données de démonstration Magic Heidi et son compte bancaire
ne sont jamais repris. Les autres entreprises conservent leur nom d'émetteur.

L'acompte est facultatif (0 % par défaut) et paramétrable sur chaque devis ou
facture. Il est conservé à la conversion : 30 % de 1’090 CHF = 327 CHF.
Le QR demande l'acompte restant tant qu'il n'est pas encaissé, puis le solde
global. Les paiements réduisent le solde sans modifier le total du document.
Le PDF indique le montant demandé ; régénérer le QR après un paiement partiel.
Les devis comportent une zone de signature et les factures émises peuvent
comporter une page QR séparée.

## Parcours

1. Ouvrir Devis ou Factures puis **Paramètres de facturation**. Renseigner les
   coordonnées de chaque entreprise, son numéro TVA si applicable, son IBAN,
   son délai de paiement et ses textes par défaut. Aucun taux TVA n'est imposé.
2. Créer le client avec adresse structurée (rue, numéro, code postal, ville,
   pays) et e-mail. Le formulaire filtre les clients et chantiers par entreprise.
3. Créer le document : objet, dates, prestations, quantité, unité, prix HT,
   remise et taux TVA par ligne. Les prestations précédentes sont réutilisables.
   Le total se recalcule immédiatement ; le serveur le vérifie à la sauvegarde.
4. Vérifier le brouillon. Il peut être modifié ou dupliqué ; il reste invisible
   dans l'espace client. L'émission le verrouille et conserve les coordonnées
   du client et de l'entreprise, indépendamment des modifications futures.
5. Le client accepte le devis dans le portail, ou la comptabilité enregistre
   l'accord/refus reçu avec une note justificative. Un devis accepté peut être
   converti une seule fois en facture brouillon, avec choix des dates. Les
   lignes, conditions et coordonnées sont conservées ; les documents sont liés.
6. Émettre la facture, télécharger son PDF et, si les informations bancaires
   sont complètes, son PDF avec QR. Enregistrer chaque paiement pour actualiser
   le payé et le solde ; le QR encode le solde actuel, arrondi au centime.

## Documents et envoi

- PDF natifs en FR, DE, IT ou EN : libellés traduits, prestations et textes libres
  conservés dans leur langue de saisie. Un PDF contient les remises, bases TVA,
  taxes, totaux, échéance, conditions et une zone de signature facultative.
- L'impression depuis l'écran reste en français. Pour un document dans une
  autre langue, utiliser **Télécharger PDF**.
- **Préparer e-mail avec PDF (.eml)** télécharge un brouillon avec destinataire
  et pièce jointe. L'ouvrir dans une messagerie compatible, vérifier puis envoyer.
  Aucun e-mail externe n'est envoyé par le serveur. SMTP, envois automatiques,
  relances et suivi de réception ne sont pas implémentés.
- Le QR utilise `swissqrbill` 4.4.1 avec adresses structurées. L'IBAN et sa clé
  sont contrôlés. Un QR-IBAN nécessite une référence QR valide ; un IBAN usuel
  accepte l'absence de référence ou une référence créancier valide. Les erreurs
  bancaires bloquent la génération QR, sans générer un code de remplacement.
- Les coordonnées doivent être complétées **avant émission**. Une ancienne
  facture sans adresse/IBAN complet peut être téléchargée sans QR. Le QR doit
  être régénéré après chaque paiement partiel ; un ancien PDF reste inchangé.

## Compatibilité et validation

Migration additive dans l'état JSON existant ; aucun effacement de données.
Les anciens documents sans taux sont affichés avec leurs montants historiques.
Les commandes gardent le contrôle de version, la transaction, l'idempotence et
les restrictions de rôle et d'entreprise. Aucun déploiement automatique ajouté.

Tests : `npm ci && npm test`. Ils couvrent les calculs mixtes, l'arrondi, les
brouillons, les instantanés, la conversion unique, les droits, les exports et le
parcours de formulaire dans un DOM simulé. Le navigateur distant n'a pas permis
de terminer la création dans Magic Heidi (session invitée, chargement persistant,
puis limite d'utilisation du contrôle). Les réglages ont été observés ; la suite
du parcours est étayée par sa documentation officielle, pas par un test complet.

Sources consultées le 17 septembre 2026 :
- https://magicheidi.ch/fr/quotes
- https://www.estv.admin.ch/fr/taux-de-la-tva-suisse
- https://github.com/schoero/swissqrbill

Restent distincts du périmètre livré : rapprochement bancaire, relances
automatiques, signature qualifiée, avoirs, échéanciers d'acomptes et comptabilité
en partie double. Les calculs ne déterminent pas le régime fiscal de l'entreprise.
