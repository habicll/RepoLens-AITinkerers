# RepoLens

**From messy GitHub issue to actionable engineering context.**

RepoLens (initialement appelé IssueLens) aide à comprendre une issue avant de commencer son implémentation. Depuis une vraie page GitHub, ouvrez le panneau Chrome et cliquez sur **Understand** : l'agent lit la discussion, explore quelques fichiers et produit une fiche sourcée.

Les observations trouvées dans GitHub sont distinguées des hypothèses du modèle. Un deuxième clic sur **Propose a solution** produit une approche et un plan. Aucune modification du repository n'est exécutée.

## Fonctionnalités du MVP

- Détection de l'issue ouverte, sans copier son contenu.
- Description, labels, assignees, milestone et commentaires récupérés avec GitHub REST.
- README et code lus à un commit fixé pour toute l'analyse.
- Exploration progressive avec trois outils : vue du repository, recherche et lecture de fichier.
- Résumé, faits importants, tentatives et fichiers pertinents.
- Hypothèses explicitement identifiées avec confiance qualitative ; aucun pourcentage artificiel.
- Extraits et liens vers l'issue, les commentaires et les lignes de code.
- Reproduction, lancement et contexte supplémentaire repliables.
- Proposition de solution uniquement après une analyse terminée et un clic explicite.
- Progression, annulation, erreurs, accès refusé et configuration manquante.

Le MVP prend en charge **GitHub.com et les repositories publics**. Il fonctionne entièrement en lecture seule. Solve, repos privés, comptes utilisateurs, analyse de PR, recherche externe et indexation complète restent hors scope.

## Architecture

```text
Chrome side panel / page locale (React + Vite)
        │ contexte de l'issue et actions
        ▼
CopilotKit v2 — état partagé et transport AG-UI
        ▼
Express local → RepoLensAgent
        ├── GitHub REST : collecte bornée et sources au SHA
        └── OpenAI Responses : outils puis sorties structurées
```

Un seul package npm. Le frontend vit dans `client/`, le backend dans `server/`, les contrats Zod dans `shared/` et le worker Chrome dans `extension/`.

CopilotKit n'est pas un widget ajouté à côté du produit : `useAgentContext` fournit l'issue courante ; `useAgent` expose l'état ; les boutons utilisent `runAgent` et `stopAgent`. Le runtime enregistre notre agent AG-UI dans le même processus Node.

Le contexte client est validé côté serveur. La proposition utilise les preuves conservées côté serveur pour le même thread et le même commit ; elle ne fait pas confiance à une analyse envoyée par le navigateur.

Quand des commentaires sont disponibles, le schéma impose des faits de discussion citant ces commentaires. Les mécanismes du code restent dans le contexte et les hypothèses. Les modèles GPT-5 généraux utilisent un effort de raisonnement `low`.

## Installation

Prérequis : **Node.js 22.12+**, npm et Chrome récent pour l'extension.

```bash
npm ci
cp .env.example .env
```

Renseignez `OPENAI_API_KEY` dans `.env`. Ce fichier est ignoré par Git. **Ne mettez jamais de secret dans une variable `VITE_`** : ces variables sont publiques et compilées dans le frontend.

## Variables d'environnement

| Variable | Utilisation |
| --- | --- |
| `OPENAI_API_KEY` | Obligatoire pour une vraie analyse ; serveur uniquement. |
| `OPENAI_MODEL` | Modèle compatible Responses, function calling et Structured Outputs ; défaut `gpt-5.4`. |
| `GITHUB_TOKEN` | Facultatif pour les repos publics, recommandé pour les quotas et la recherche de contenu. |
| `PORT` | Port du backend, `3001` par défaut. |
| `HOST` | Adresse locale, `127.0.0.1` par défaut. Le MVP refuse une écoute publique. |
| `GITHUB_ALLOWED_REPOS` | Liste facultative `owner/repo,other/repo` limitant la démo. |
| `EXTENSION_ID` | Facultatif : restreint l'accès à l'ID de l'extension Chrome chargée. |
| `VITE_API_URL` | Adresse publique du backend, `http://127.0.0.1:3001`. Aucun secret. |
| `COPILOTKIT_TELEMETRY_DISABLED` | `true` dans la configuration de démo. |
| `DO_NOT_TRACK` | `1` dans la configuration de démo. |

Sans `GITHUB_TOKEN`, RepoLens utilise l'API publique et cherche dans les chemins découverts. La recherche de contenu GitHub reste indisponible. La limite GitHub non authentifiée est partagée par IP ; l'interface signale les limitations.

Après une modification de `.env`, redémarrez le serveur. Après une modification de `VITE_API_URL`, reconstruisez l'extension.

## Lancer la page locale

```bash
npm run dev
```

Ouvrez **http://127.0.0.1:5173**. Collez l'URL d'une issue publique, puis cliquez sur **Understand**. Cette page sert au développement et partage le même parcours que l'extension.

## Utiliser RepoLens / IssueLens dans GitHub

```bash
npm run build
npm start
```

1. Ouvrez `chrome://extensions` et activez **Developer mode**.
2. Cliquez **Load unpacked** et sélectionnez le dossier `dist-extension/` de ce repository.
3. Épinglez RepoLens dans la barre d'outils Chrome.
4. Ouvrez une vraie page `https://github.com/owner/repo/issues/123`.
5. Cliquez sur l'icône RepoLens : le panneau reconnaît l'issue.
6. Cliquez **Understand** et inspectez les sources à côté des affirmations.
7. Cliquez **Propose a solution** quand vous souhaitez passer au plan.

Le backend doit rester lancé. Après un nouveau build, rechargez l'extension dans `chrome://extensions`.

La page compilée est aussi disponible sur **http://127.0.0.1:3001** avec `npm start`.

## Provenance et limites

L'agent ne reçoit pas tout le repository. La collecte limite notamment les commentaires (100 et 24 000 caractères), les fichiers (6, README compris), les lectures (160 lignes par extrait, fichier de 100 Ko maximum) et le texte total des sources (64 000 caractères). Le workflow limite les appels modèle à 6, les outils à 10 et un run à 90 secondes.

Les outils ne peuvent lire que le repository courant. Secrets usuels, dépendances, fichiers générés, binaires, symlinks et sous-modules sont exclus. La recherche fournit des candidats ; seuls les extraits lus peuvent servir de sources de code.

La validation des citations vérifie qu'une source a été récupérée et que les fichiers indiqués ont été lus. Elle ne prouve pas chaque interprétation du modèle. Les tests et commandes de reproduction présentés ne sont pas exécutés.

Les commentaires, README et fichiers sont traités comme des données non fiables. Ils ne peuvent débloquer un outil d'écriture ou d'exécution. Les logs contiennent les étapes, compteurs, durées et erreurs normalisées, sans clé ni corps des sources.

Les réponses GitHub publiques sont mises en cache brièvement ; les fichiers sont associés au SHA. Les analyses nécessaires au second clic expirent après 15 minutes et disparaissent au redémarrage. Une analyse d'une vieille issue porte sur le commit affiché, qui peut différer de la version affectée.

Les appels OpenAI utilisent `store: false`. Cela ne constitue pas une garantie d'absence totale de rétention côté fournisseur.

## Tests et vérifications

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run check:secrets
```

Les tests unitaires vérifient les accès, budgets, citations, changements de contexte et transitions. Les tests navigateur utilisent **le vrai runtime CopilotKit** avec un agent de test synthétique, sans appel externe. Ces données ne sont jamais chargées par l'application normale.

Le test extension charge le worker MV3 et le bundle dans Chromium, détecte les URL des onglets et vérifie les changements d'issue et la CSP. Il ouvre la page du panneau dans un onglet d'extension inactif ; le geste natif sur l'icône de la barre Chrome reste à vérifier lors de la répétition de démo.

Arrêtez `npm run dev` ou `npm start` avant les tests navigateur : ils démarrent leurs propres serveurs sur les ports 3001 et 5173.

Pour un test réel GitHub + OpenAI (consomme des crédits API) :

```bash
npm run check:live -- https://github.com/expressjs/express/issues/7350 --solution
```

Les résultats sont écrits dans `local-results/`, ignoré par Git. Aucune réponse fictive ne remplace un échec de l'API en production.

`check:secrets` recherche les clés locales dans les sources, les builds et l'historique Git, vérifie que `.env` n'est pas suivi et recherche aussi des formats de tokens courants. Il n'affiche jamais les valeurs détectées.

## Dépannage

- **Analysis is not configured** : renseigner la clé côté serveur, redémarrer puis cliquer Check connection.
- **Service offline** : vérifier que le serveur écoute sur l'adresse définie par `VITE_API_URL`.
- **Permission denied** : utiliser une issue publique et vérifier la portée du token ou l'allowlist.
- **GitHub rate limit** : attendre le renouvellement du quota ou configurer un token personnel adapté.
- **Analyse interrompue** : relancer Understand ; changer d'issue annule l'analyse précédente.
- **Proposition expirée** : relancer Understand après expiration du snapshot ou redémarrage.

Le provider CopilotKit installé embarque aussi des composants différés inutilisés par cette interface. Le build signale donc un bundle volumineux ; les ressources restent empaquetées localement dans l'extension. Réduire ce poids est une optimisation ultérieure, sans impact sur le parcours principal validé.

## Construit pendant le hackathon

Le dépôt initial ne contenait que son titre. Le travail comprend le challenge de la V1, le périmètre V2, la collecte GitHub, l'agent OpenAI, l'intégration CopilotKit, l'interface sourcée, l'extension Chrome, les tests et la documentation. Les étapes sont enregistrées par commits sur `feat/mvp-issue-context`.

Voir [le plan challengé](docs/plan.md) et [la recette de démonstration](docs/demo.md).
