# Démontrer RepoLens

## Préparation

1. Installer les dépendances avec `npm ci` et renseigner la clé dans le fichier local `.env`.
2. Configurer si possible `GITHUB_TOKEN` pour limiter le risque de quota partagé pendant la démo. Les repositories privés restent refusés.
3. Exécuter `npm run build`, puis `npm start`.
4. Charger `dist-extension/` dans `chrome://extensions` en mode développeur, puis recharger la page GitHub. Un bouton RepoLens apparaît en bas à droite.
5. Garder le terminal du backend visible pour les étapes, durées, compteurs d'outils et erreurs. Aucun secret n'est nécessaire à l'écran.

Ne pas ouvrir `.env` pendant la présentation. `npm run check:secrets` contrôle les fichiers destinés à Git ainsi que les builds et l'historique.

## Une vraie issue de démonstration

[expressjs/express #7350](https://github.com/expressjs/express/issues/7350) signale une erreur opaque lorsqu'un nom de vue se termine par un point. La discussion contient des propositions de correctifs, des PR mentionnées et une objection concrète : un fichier dont le nom se termine réellement par un point ne doit pas être oublié.

Cette issue permet de montrer la différence entre résumer un rapport de bug et comprendre ce qui bloque encore une décision d'ingénierie. RepoLens doit lire les commentaires, retrouver les fonctions de rendu et expliquer le désaccord sans inventer de consensus. Une proposition responsable peut demander de trancher le comportement attendu avant de détailler un correctif.

La discussion GitHub peut évoluer. Faire une répétition proche de la présentation et vérifier les sources proposées ; le texte exact et les fichiers choisis par le modèle ne sont pas garantis.

## Parcours de présentation, environ 90 secondes

1. **Partir de GitHub.** Ouvrir l'issue réelle, puis la fenêtre flottante RepoLens. Montrer qu'elle vit au-dessus de GitHub et connaît déjà le repository et le numéro, sans copier de texte.
2. **Cliquer Understand.** Les étapes montrent la collecte de la discussion et l'exploration ciblée du code. Expliquer que l'agent reçoit seulement quelques extraits.
3. **Lire le problème.** Une synthèse courte, quelques faits et les tentatives remplacent la lecture de toute la discussion.
4. **Ouvrir une preuve.** Cliquer la source d'un commentaire, puis celle d'un fichier. Montrer l'extrait et le lien vers les lignes au commit analysé.
5. **Distinguer observation et hypothèse.** Montrer le bloc Working hypothesis, les limites de contexte et les questions encore ouvertes.
6. **Lancer Forensics à la demande.** Cliquer Investigate issue. Montrer la progression réelle, la timeline, le candidat le plus plausible et pourquoi il est classé `HIGH`, `MEDIUM` ou `LOW`. Ouvrir la PR ou le commit, puis comparer les colonnes Facts et Inferences. Si aucune preuve n'est forte, le refus de désigner un coupable fait partie de la démonstration.
7. **Demander la solution.** Revenir au briefing et cliquer Propose a solution. Aucun plan n'apparaît avant ce clic. Si le comportement attendu est encore contesté, montrer la question précise à résoudre plutôt qu'annoncer un correctif certain.
8. **Implémenter quand c'est responsable.** Sur une issue dont la solution est concrète, cliquer Implement solution. Montrer le diff, ses fichiers sources et les actions Copy/Download. Répéter qu'il s'agit d'un brouillon non appliqué et non testé. Sur l'issue Express, l'absence de bouton est le bon comportement tant que le désaccord reste ouvert.

## Parcours repository, environ 45 secondes

1. Ouvrir la racine d'un vrai repository. RepoLens affiche automatiquement son nom sans copier l'URL.
2. Cliquer **Understand**. Montrer la phrase qui résume le projet, son audience et les quelques concepts qui rendent le README lisible.
3. Ouvrir une source README : l'explication renvoie au texte réellement récupéré et au commit analysé.
4. Montrer la box sombre **Paste this into your terminal**, puis copier toute la recette Bash en un clic. Les commandes viennent du manifest et restent visibles avant toute exécution.
5. Pour une démo contrôlée uniquement, activer `ENABLE_LOCAL_EXECUTION=true`, utiliser un repository de confiance, cocher l'autorisation, lancer puis montrer les logs, l'URL locale et **Stop**.

Ne lancez pas un repository tiers inconnu pendant la présentation. La compréhension du README fonctionne même lorsque l'exécution locale reste désactivée.

Phrase de présentation : « RepoLens transforme une discussion GitHub dispersée en contexte d'ingénierie vérifiable, avant d'écrire le code. »

## Ce que CopilotKit apporte

La fenêtre transmet le repository ou l'issue courante par `useAgentContext`. Les actions pilotent un agent enregistré dans le runtime CopilotKit ; son état partagé alimente directement progression, sources, briefing, analyse, plan et patch. Un changement de page isole le thread et annule le travail précédent. L'expérience est contextuelle et structurée, sans fenêtre de chat générique.

## Si une dépendance externe tombe

- Une erreur d'accès ou de quota reste visible ; ne pas présenter une réponse enregistrée comme une nouvelle analyse.
- La page `http://127.0.0.1:3001` fournit le même parcours si l'ouverture du panneau pose problème. Elle demande l'URL de l'issue.
- Les tests E2E sont synthétiques et servent à vérifier le transport et l'interface. Ils ne constituent pas une démo de compréhension par OpenAI.
- Le backend doit rester lancé ; après quinze minutes ou un redémarrage, relancer Understand avant de demander une solution.

## Vérification technique

Vérification locale du 12 septembre 2026 : **65 tests unitaires et 7 tests navigateur réussis**, typecheck et build réussis. Le contrôle des secrets a vérifié sources, builds et historique Git ; `.env` n'est pas suivi.

Le parcours complet dans le navigateur, avec le vrai runtime CopilotKit, GitHub et OpenAI `gpt-5.4`, a analysé l'issue Express en **21,4 secondes** puis produit la proposition sur clic en **4,7 secondes**. Il a récupéré les sept commentaires et trois fichiers, README compris, identifié `lib/view.js` et `lib/application.js`, et affiché le désaccord sur le comportement attendu avec ses sources. La proposition a correctement demandé de trancher ce comportement, sans présenter un plan de fix comme acquis. Aucune erreur navigateur n'a été détectée.

Ce sont des mesures d'un run local, pas des garanties de latence ni de qualité sur toutes les issues. La génération structurée du patch a aussi été vérifiée avec OpenAI sur un contexte synthétique borné. Le parcours complet de l'extension MV3 a été vérifié séparément avec des réponses synthétiques de test.

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run check:secrets
```

Les tests navigateur lancent leurs propres serveurs : arrêter `npm start` ou `npm run dev` avant de les exécuter.

Pour vérifier directement GitHub et OpenAI en consommant des crédits API :

```bash
npm run check:live -- https://github.com/expressjs/express/issues/7350 --solution
npm run check:live -- https://github.com/expressjs/express
```

Les résultats restent dans `local-results/`, hors Git. Les mesures dépendent du réseau, du quota et du modèle configuré ; aucun délai fixe de génération n'est promis.
