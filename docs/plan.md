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

## Réussite et limites

Le résultat doit se lire en moins de 30 secondes. Cette cible de lecture n'est pas une garantie de latence du modèle. L'analyse vise 30–60 secondes avec expiration contrôlée. Aucune simulation de réponse en production ; seules les réponses des tests peuvent être simulées. L'absence de clé OpenAI est signalée explicitement.

Une démo réussie montre une information utile provenant d'un commentaire, son lien avec un fichier effectivement lu, puis une approche crédible sur clic. Tous les autres enrichissements restent secondaires.

Sources :
- https://docs.github.com/en/copilot/tutorials/explore-issues-and-discussions
- https://docs.copilotkit.ai/runtime-server-adapter
- https://docs.copilotkit.ai/programmatic-control
- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developers.openai.com/api/docs/guides/structured-outputs
