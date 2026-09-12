# RepoLens — du plan V1 au MVP V2

## Audit avant développement

Le dépôt ne contenait que son README et le commit initial. Aucun framework, service ou test existant. Node 22 disponible. Les clés OpenAI/GitHub n'étaient pas configurées lors de l'audit.

## Architecture et V1

La V1 proposait une extension Chrome avec panneau React, un backend TypeScript, CopilotKit comme transport/contextualisation, OpenAI Responses, GitHub REST et un package de contrats partagés. Étapes : socle, contexte d'onglet, collecte GitHub, quatre outils d'exploration, compréhension, proposition séparée, citations et robustesse. Pas de Solve obligatoire.

## Risques et challenge, terminé avant toute implémentation

- GitHub Copilot charge déjà une issue comme contexte et résume ses commentaires. Notre différenciation doit être une fiche exploitable, sourcée, qui relie les tentatives de la discussion au code réellement lu. Le contexte automatique seul ne suffit pas.
- Sept sections ouvertes ralentissent la lecture. Réduire le premier écran au problème, aux tentatives et aux fichiers pertinents ; mettre les détails en accordéons.
- Une confiance de 82 % serait une précision trompeuse. Afficher des hypothèses et une confiance qualitative justifiée.
- Un workspace multipackage n'est pas nécessaire pour deux processus et quelques types.
- Une page web avec URL est plus simple à développer mais perd l'expérience contextuelle. Garder une extension fine qui réutilise exactement le même frontend.
- Le backend charge l'issue et les commentaires de façon déterministe. Aucun outil LLM supplémentaire pour redemander ces données connues.
- Les limites, permissions, cache et citations sont contrôlés par le code. La sélection des pistes et leur interprétation appartiennent au modèle.
- Zod valide la forme ; la validation des sourceIds et des fichiers lus ajoute la traçabilité mais ne garantit pas la véracité sémantique.
- La navigation et l'arrivée tardive de résultats peuvent casser la démo. Chaque analyse est liée à une issue, un thread et un run.
- Le streaming peut fonctionner dans une page et échouer dans une extension. Vérifier les packages publiés, la CSP et le runtime dès le premier parcours.

## V2 retenue

Un package npm, client React/Vite, serveur Express local, schémas Zod partagés, extension Chrome Manifest V3. Trois intégrations métier : GitHub, OpenAI, CopilotKit. Un seul agent.

Conservé : contexte automatique, API GitHub réelle, lecture progressive, sources cliquables, distinction des faits et hypothèses, proposition uniquement après clic.

Modifié : trois outils (overview, search, read_file), six fichiers maximum, collecte bornée, état partagé CopilotKit alimentant des cartes simples, cache court en mémoire et par commit SHA.

Supprimé : Solve, chat libre, insertion dans le DOM GitHub, OAuth multi-utilisateur, repos privés, Exa, graphes de PR, indexation complète, base de données.

Ajouté : état de configuration, protection contre les résultats obsolètes, vérification des citations, logs de compteurs/durées sans contenu sensible et tests des erreurs.

## Parcours

GitHub issue → ouverture RepoLens → Understand issue → collecte réelle → exploration bornée → trois blocs principaux sourcés → clic Propose a solution → approche et plan. Aucune solution préchargée. Pas d'outil de modification ou d'exécution.

La première collecte respecte les dépendances : issue et commentaires dépendent du contrôle d'accès du repository ; README et fichiers dépendent de la résolution du SHA. Les lectures indépendantes sont parallélisées. La recherche GitHub renvoie des candidats à relire au SHA choisi.

## Ordre d'implémentation

1. Socle, variables d'environnement et contrats.
2. Liaison extension/CopilotKit/agent et collecte GitHub en parallèle.
3. Exploration, contrôle des sources et analyse structurée.
4. Interface sourcée, états vides, erreurs, chargement et accès refusé.
5. Proposition à partir du snapshot validé côté serveur.
6. Tests unitaires et parcours navigateur ; vérification de la collecte sur une vraie issue.
7. README, répétition de démo, mesures et limites clairement documentées.

## Spécification concrète de la V2

### Périmètre

| Priorité | Contenu | Critère de réussite |
| --- | --- | --- |
| MUST HAVE | Issue publique courante reconnue par Chrome ; collecte discussion + README ; code exploré progressivement ; fiche et preuves ; hypothèses distinctes ; proposition séparée ; erreurs explicites | Une issue réelle aboutit à une synthèse dont les liens permettent de retrouver les preuves |
| SHOULD HAVE | Annulation et changement d'issue sûrs ; sources au SHA ; quotas visibles ; tests de bout en bout ; cache court | Aucun résultat d'une ancienne issue ne remplace la nouvelle ; les limites sont lisibles |
| NICE TO HAVE | Recherche GitHub de contenu avec token ; plusieurs issues de démonstration | Améliore la découverte sans conditionner l'analyse des chemins déjà connus |
| NOT FOR HACKATHON | Solve, écriture Git, PR automatiques, accès privé, OAuth, Exa, indexation vectorielle, compréhension universelle de tous les langages | Aucun de ces éléments ne retarde le chemin principal |

### Composants et responsabilités

- `extension/background.js` observe l'onglet actif et transmet seulement URL, identifiant d'onglet et fenêtre. Il n'extrait pas le DOM de GitHub et ne transporte aucune clé.
- `client/App.tsx` transforme l'URL en `IssueRef`, expose ce contexte à CopilotKit et lance les actions. Chaque issue dispose d'un thread distinct.
- `client/components/AnalysisView.tsx` affiche des données structurées sous forme de cartes, détails repliables et aperçus des sources ; aucune réponse HTML du modèle n'est exécutée.
- `server/index.ts` configure l'API locale, contrôle Host/Origin et installe le runtime CopilotKit avec un seul agent.
- `server/agent.ts` orchestre les transitions, événements AG-UI, annulation et sessions. Le serveur valide à nouveau l'issue et l'intention.
- `server/github.ts` centralise permissions, requêtes GitHub, pagination, cache, budgets, chemins et provenance.
- `server/analysis.ts` exécute les outils OpenAI et valide les sorties ; `server/prompts.ts` sépare compréhension et solution.
- `server/session.ts` garde un snapshot temporaire pour la proposition suivante. Pas de base de données.

### Flux précis

1. Un clic sur l'icône ouvre le panneau ; le worker fournit l'issue de la fenêtre concernée.
2. Understand envoie l'intention et la référence de l'issue via CopilotKit, avec `threadId` et `runId`.
3. Le serveur valide le contexte, vérifie que le repository est public et applique l'allowlist éventuelle.
4. Il récupère l'issue et la branche en parallèle. La branche fixe le commit du code à inspecter.
5. Les commentaires, l'arbre racine et le README sont récupérés en parallèle. L'ajout des sources et l'allocation des budgets restent déterministes.
6. OpenAI reçoit ce contexte initial et peut demander une vue de dossier, une recherche ou un extrait de fichier. Les budgets et permissions ne dépendent jamais du jugement du modèle.
7. Une passe finale produit l'analyse typée. Les identifiants de sources doivent exister ; les fichiers cités doivent avoir été lus.
8. L'état AG-UI met à jour l'interface et le serveur conserve les preuves pendant quinze minutes.
9. Propose a solution utilise ce snapshot côté serveur, pour le même thread et la même issue. Cette action n'autorise ni écriture ni exécution.

### Contrats de données

| Structure | Champs essentiels | Invariant |
| --- | --- | --- |
| `IssueRef` | owner, repo, number, url canonique | GitHub.com, HTTPS et chemin d'issue valide |
| `IssueMetadata` | title, state, author, labels, assignees, milestone | Valeurs provenant de l'API, pas de priorité inventée |
| `Source` | id, kind, url, excerpt ; path et lignes pour le code ; auteur/date pour la discussion | Une source existe seulement après récupération effective |
| `Snapshot` | id, commitSha, branch, fetchedAt | Toutes les lectures de code partagent le commit |
| `Coverage` | commentaires lus/total, fichiers lus, chemins découverts, troncatures, recherche disponible, limites | Une exploration partielle n'est pas présentée comme exhaustive |
| `Claim` | text, sourceIds | Au moins une référence récupérée |
| `Analysis` | summary, facts, alreadyTried, relevantFiles, hypotheses, relevantContext, reproduction, howToRun, unknowns | Aucun champ de solution ; suggestions distinctes des tentatives rapportées |
| `Solution` | status, approach, assumptions, steps, risks, openQuestions | `needs_more_information` implique un plan vide |
| `RepoLensState` | issue, runId, status, phase, activities, sources, coverage, snapshot, analysisId, analysis, solution, error | Le client n'affiche que le run et l'issue attendus |

Pas de modèle `Comment` distinct nécessaire : ses données utiles sont représentées par une `Source` de type `comment`. Pas de `RepositoryContext` universel : le snapshot, les chemins découverts et les sources suffisent.

### API et outils

GitHub REST, en lecture seule :

| Endpoint | Utilisation |
| --- | --- |
| `GET /repos/{owner}/{repo}` | Visibilité, identité canonique et branche par défaut |
| `GET /repos/{owner}/{repo}/issues/{number}` | Description et métadonnées ; rejet des PR |
| `GET /repos/{owner}/{repo}/issues/{number}/comments` | Pagination bornée, ordre chronologique |
| `GET /repos/{owner}/{repo}/branches/{branch}` | Commit et arbre racine |
| `GET /repos/{owner}/{repo}/readme?ref={sha}` | Documentation initiale |
| `GET /repos/{owner}/{repo}/git/trees/{treeSha}` | Exploration non récursive des répertoires |
| `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` | Lecture ciblée et bornée |
| `GET /search/code?q=...` | Candidats supplémentaires avec token ; relus ensuite au SHA |

Trois outils OpenAI seulement : `repo_overview({directory})`, `search_repository({terms,pathPrefix})`, `read_file({path,startLine,endLine})`. La collecte initiale est déterministe ; aucun outil pour demander à nouveau l'issue courante. Les outils restent séquentiels dans le workflow pour préserver le budget partagé ; les appels indépendants du bootstrap sont parallélisés.

OpenAI Responses utilise function calling strict puis Structured Outputs via Zod. Les appels ne stockent pas les réponses avec `store: true`. Le runtime CopilotKit expose le transport AG-UI sous `/api/copilotkit` ; `/api/health` expose seulement des indicateurs de configuration et le modèle.

Exa ne répond à aucun besoin indispensable sur la démonstration retenue : intégration supprimée du MVP.

### Instructions et fiabilité des sorties

Le prompt de compréhension demande un symptôme et son impact, trois faits maximum, quatre tentatives maximum, deux à quatre fichiers lus et des hypothèses explicitement qualifiées. Il privilégie les commentaires qui changent la décision : contre-exemple, correction, résultat rapporté, désaccord ou PR fermée. Le README ne doit pas masquer la discussion.

Le prompt de proposition consulte les objections avant de choisir une approche. Si le comportement attendu reste contesté sans résolution, il demande la décision manquante au lieu d'inventer un consensus. Les commandes de reproduction ne sont jamais annoncées comme exécutées.

La validation refuse les sources inexistantes et les chemins non lus. Elle contrôle la forme et la provenance ; une relecture humaine des sources reste nécessaire pour juger l'interprétation. Aucun pourcentage de confiance artificiel.

### Sécurité et démo

Les secrets restent dans `.env`, serveur uniquement. L'extension possède `sidePanel` et l'accès aux domaines GitHub et au backend local. Aucun accès GitHub en écriture n'est nécessaire ; même avec un token plus permissif, le MVP refuse les repositories privés. L'utilisation est locale, sans comptes ni service multi-utilisateur exposé.

Le contenu du repository est non fiable et ne peut ajouter de nouveaux outils. Les chemins sensibles courants et fichiers inadaptés sont exclus. Il n'existe pas d'action destructive à confirmer. Le clic sur Propose a solution autorise une génération supplémentaire, pas un fix.

### Jalons et résultats vérifiables

| Étape | Objectif et fichiers | Dépendances | Vérification |
| --- | --- | --- | --- |
| 1 | Socle : package.json, configs, .env.example, shared/contracts.ts | Aucune base applicative existante | Installation, types et validation des URL |
| 2 | Collecte : server/github.ts, server/errors.ts | Contrats et référence canonique | Fixtures GitHub : pagination, permissions, budgets, SHA et chemins |
| 3 | Agent : server/agent.ts, analysis.ts, prompts.ts, session.ts | Collecte + SDK OpenAI | Analyse typée, citations refusées si invalides, proposition liée au snapshot |
| 4 | Runtime : server/index.ts | Agent AG-UI | Health, origine refusée, connexion CopilotKit réelle |
| 5 | Interface : client/App.tsx, components/AnalysisView.tsx, styles.css | Contrats et runtime | Chargement, lecture des sources, plan sur clic, erreur et annulation |
| 6 | Extension : manifest, worker, build-extension.mjs | Même frontend compilé | Worker MV3 chargé, contexte détecté, navigation prise en compte |
| 7 | Démo : tests/e2e, check-live.ts, README, docs/demo.md | Parcours complet | Test navigateur + vraie issue GitHub/OpenAI ; contrôle des secrets |

## Réussite et limites

Le résultat doit se lire en moins de 30 secondes. Cette cible de lecture n'est pas une garantie de latence du modèle. L'analyse vise 30–60 secondes avec expiration contrôlée. Aucune simulation de réponse en production ; seules les réponses des tests peuvent être simulées. L'absence de clé OpenAI est signalée explicitement.

Une démo réussie montre une information utile provenant d'un commentaire, son lien avec un fichier effectivement lu, puis une approche crédible sur clic. Tous les autres enrichissements restent secondaires.

Sources :
- https://docs.github.com/en/copilot/tutorials/explore-issues-and-discussions
- https://docs.copilotkit.ai/runtime-server-adapter
- https://docs.copilotkit.ai/programmatic-control
- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developers.openai.com/api/docs/guides/structured-outputs
