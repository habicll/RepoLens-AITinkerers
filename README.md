# RepoLens

**From messy GitHub issue to actionable engineering context.**

RepoLens (initialement appelé IssueLens) aide à comprendre un repository ou une issue avant de commencer à travailler. Depuis une vraie page GitHub, ouvrez la fenêtre flottante sombre et cliquez sur **Understand** : sur la racine du repository, l'agent explique le README ; sur une issue, il lit la discussion, explore quelques fichiers et produit une fiche sourcée.

Les observations trouvées dans GitHub sont distinguées des hypothèses du modèle. **Investigate issue** lance à la demande une enquête sur les changements qui précèdent le signalement. **Propose a solution** produit ensuite une approche et un plan. Quand ce plan est suffisamment concret, **Implement solution** génère un patch à relire, copier ou télécharger. RepoLens ne l'applique pas et n'exécute pas les tests.

## Fonctionnalités du MVP

- Détection de l'issue ouverte, sans copier son contenu.
- Détection de la page racine d'un repository et briefing très court du README : but, audience et trois concepts essentiels au maximum.
- Box Bash immédiatement visible avec la recette Node/npm déterministe, prête à copier dans un terminal.
- Description, labels, assignees, milestone et commentaires récupérés avec GitHub REST.
- README et code lus à un commit fixé pour toute l'analyse.
- Exploration progressive avec trois outils : vue du repository, recherche et lecture de fichier.
- Résumé, faits importants, tentatives et fichiers pertinents.
- Hypothèses explicitement identifiées avec confiance qualitative ; aucun pourcentage artificiel.
- Extraits et liens vers l'issue, les commentaires et les lignes de code.
- Reproduction, lancement et contexte supplémentaire repliables.
- Proposition de solution uniquement après une analyse terminée et un clic explicite.
- Issue Forensics uniquement après un clic explicite : fenêtre de sept jours, commits/PR récents, timeline, CI, déploiements, preuves et confiance qualitative.
- Séparation visuelle entre faits GitHub et inférences causales ; aucun responsable n'est inventé quand les preuves sont faibles.
- Brouillon d'implémentation uniquement après une solution concrète : diff borné aux fichiers inspectés, jamais appliqué automatiquement.
- Progression, annulation, erreurs, accès refusé et configuration manquante.
- Proposition facultative de lancement local pour les projets Node/npm reconnus : commandes visibles, consentement explicite, logs en direct, URL locale et bouton Stop.

Le MVP prend en charge **GitHub.com et les repositories publics**. L'analyse reste en lecture seule. Le lancement local est désactivé par défaut et ne s'active que sur le serveur de l'utilisateur. L'application automatique du patch, les PR, les repos privés, les comptes utilisateurs, l'analyse de PR, la recherche externe et l'indexation complète restent hors scope.

## Architecture

```text
Fenêtre flottante injectée dans GitHub / page locale (React + Vite)
        │ contexte du repository ou de l'issue et actions
        ▼
CopilotKit v2 — état partagé et transport AG-UI
        ▼
Express local → RepoLensAgent
        ├── GitHub REST : collecte bornée et sources au SHA
        ├── Forensics : timeline + score déterministe + comparaison sémantique
        ├── OpenAI Responses : outils puis sorties structurées
        └── Lanceur local optionnel : git/npm, processus et logs
```

Un seul package npm. Le frontend vit dans `client/`, le backend dans `server/`, les contrats Zod dans `shared/` et le worker Chrome dans `extension/`.

CopilotKit n'est pas un widget ajouté à côté du produit : `useAgentContext` fournit l'issue courante ; `useAgent` expose l'état ; les boutons utilisent `runAgent` et `stopAgent`. Le runtime enregistre notre agent AG-UI dans le même processus Node.

Le contexte client est validé côté serveur. La proposition et le patch utilisent les preuves conservées côté serveur pour le même thread et le même commit ; ils ne font pas confiance à une analyse ou une solution envoyée par le navigateur.

Quand des commentaires sont disponibles, le schéma impose des faits de discussion citant ces commentaires. Les mécanismes du code restent dans le contexte et les hypothèses. Les modèles GPT-5 généraux utilisent un effort de raisonnement `low`.

## Installation

Prérequis : **Node.js 22.12+**, npm et Chrome récent pour l'extension.

```bash
npm ci
cp .env.example .env
```

Renseignez `OPENAI_API_KEY` dans `.env`. Ce fichier est ignoré par Git. **Ne mettez jamais de secret dans une variable `VITE_`** : ces variables sont publiques et compilées dans le frontend.

Pour une démo Forensics stable, utilisez aussi l'authentification du GitHub CLI déjà connecté :

```bash
GITHUB_TOKEN="$(gh auth token)" npm run dev
```

## Variables d'environnement

| Variable | Utilisation |
| --- | --- |
| `OPENAI_API_KEY` | Obligatoire pour une vraie analyse ; serveur uniquement. |
| `OPENAI_MODEL` | Modèle compatible Responses, function calling et Structured Outputs ; défaut `gpt-5.4`. |
| `GITHUB_TOKEN` | Facultatif pour les repos publics, fortement recommandé pour Forensics, les quotas et la recherche de contenu. |
| `PORT` | Port du backend, `3001` par défaut. |
| `HOST` | Adresse locale, `127.0.0.1` par défaut. Le MVP refuse une écoute publique. |
| `GITHUB_ALLOWED_REPOS` | Liste facultative `owner/repo,other/repo` limitant la démo. |
| `FORENSICS_WINDOW_DAYS` | Nombre de jours inspectés avant la création d'une issue, de 1 à 30 ; défaut `7`. |
| `EXTENSION_ID` | Facultatif : restreint l'accès à l'ID de l'extension Chrome chargée. |
| `VITE_API_URL` | Adresse publique du backend, `http://127.0.0.1:3001`. Aucun secret. |
| `ENABLE_LOCAL_EXECUTION` | `false` par défaut. Mettre `true` autorise l'affichage du bouton de lancement contrôlé. |
| `REPOLENS_WORKSPACE_ROOT` | Dossier absolu dédié aux clones temporaires ; dossier temporaire système par défaut. |
| `COPILOTKIT_TELEMETRY_DISABLED` | `true` dans la configuration de démo. |
| `DO_NOT_TRACK` | `1` dans la configuration de démo. |

Sans `GITHUB_TOKEN`, RepoLens utilise l'API publique et cherche dans les chemins découverts. La recherche de contenu GitHub reste indisponible. La limite GitHub non authentifiée est partagée par IP ; l'interface signale les limitations.

Après une modification de `.env`, redémarrez le serveur. Après une modification de `VITE_API_URL`, reconstruisez l'extension.

## Lancer la page locale

```bash
npm run dev
```

Ouvrez **http://127.0.0.1:5173**. Collez l'URL d'un repository public ou d'une issue publique, puis cliquez sur **Understand**. Cette page sert au développement et partage le même parcours que l'extension.

## Utiliser RepoLens / IssueLens dans GitHub

```bash
npm run build
npm start
```

1. Ouvrez `chrome://extensions` et activez **Developer mode**.
2. Cliquez **Load unpacked** et sélectionnez le dossier `dist-extension/` de ce repository.
3. Rechargez l'extension après chaque nouveau build. Épingler RepoLens dans la barre d'outils est facultatif.
4. Ouvrez une vraie page `https://github.com/owner/repo` ou `https://github.com/owner/repo/issues/123`.
5. Cliquez sur le bouton RepoLens en bas à droite de GitHub, ou sur l'icône de l'extension : la fenêtre flottante reconnaît le repository ou l'issue.
6. Cliquez **Understand** et inspectez les sources à côté des affirmations. Sur la page racine, RepoLens résume le README et affiche une box Bash copiable.
7. Sur une issue, cliquez **Investigate issue** pour reconstruire les changements, CI et déploiements antérieurs. Revenez au briefing avec **Back to overview**.
8. Cliquez **Propose a solution** quand vous souhaitez passer au plan.
9. Si la solution est concrète, cliquez **Implement solution** pour générer un patch. Relisez-le avant de le copier ou le télécharger.

Le backend doit rester lancé. Après un nouveau build, rechargez l'extension dans `chrome://extensions`.

La page compilée est aussi disponible sur **http://127.0.0.1:3001** avec `npm start`.

## Lancement local optionnel

RepoLens peut proposer de lancer un projet Node/npm depuis sa page racine. Cette fonction est volontairement étroite : `package.json` doit contenir un script `dev`, `start`, `serve` ou `preview`. Le serveur choisit la recette à partir du manifest et du lockfile ; aucun texte généré par le modèle et aucune commande du README ne sont exécutés directement.

Pour l'activer sur votre machine :

```dotenv
ENABLE_LOCAL_EXECUTION=true
```

Redémarrez ensuite RepoLens et relancez **Understand**. Avant toute exécution, l'interface affiche les commandes exactes et demande de cocher une autorisation. Après validation, le serveur clone le commit analysé dans un dossier temporaire, exécute `npm ci` ou `npm install`, puis le script retenu. Les logs et une URL `localhost` détectée apparaissent dans RepoLens ; **Stop** termine le groupe de processus.

Le code du repository s'exécute avec les permissions du compte local. Le lanceur lui transmet un environnement minimal et un `HOME` temporaire ; il ne transmet pas `OPENAI_API_KEY`, `GITHUB_TOKEN` ni les autres variables du serveur. Ce mécanisme n'est pas une sandbox. N'autorisez que des repositories que vous acceptez d'exécuter sur cette machine.

## Issue Forensics

Forensics ne démarre jamais avec l'analyse normale. Après le clic **Investigate issue**, le serveur prend la date de création comme premier signalement et inspecte la fenêtre précédente configurée. Il récupère au maximum 40 commits, puis détaille les trois meilleurs et cherche leur PR associée. Timeline, commits et PR utilisent les APIs GitHub principales ; Actions et déploiements enrichissent le résultat quand les droits le permettent. Un cache de deux minutes évite qu'un retry immédiat répète les appels déjà réussis.

Le score de base est calculé dans le code avec la proximité temporelle, les chemins modifiés, les références de la timeline, un échec CI et la présence dans un déploiement. OpenAI reçoit ensuite un contexte compact pour comparer le sens de l'issue aux titres, messages et chemins. Cette passe ajoute uniquement la pertinence sémantique et le résumé. L'interface affiche `HIGH`, `MEDIUM` ou `LOW`, jamais un pourcentage artificiel.

Un candidat `LOW` ne devient pas automatiquement un coupable. En l'absence de signal suffisant, la vue indique **No strong evidence found**. Une timeline, Actions ou les déploiements indisponibles dégradent seulement la couverture ; ils n'annulent plus une enquête qui possède encore les commits récents. Le briefing normal demeure accessible si Forensics ou OpenAI échoue.

## Provenance et limites

L'agent ne reçoit pas tout le repository. La collecte limite notamment les commentaires (100 et 24 000 caractères), les fichiers (6, README compris), les lectures (160 lignes par extrait, fichier de 100 Ko maximum) et le texte total des sources (64 000 caractères). Le workflow limite les appels modèle à 6, les outils à 10 et un run à 90 secondes.

Les outils ne peuvent lire que le repository courant. Secrets usuels, dépendances, fichiers générés, binaires, symlinks et sous-modules sont exclus. La recherche fournit des candidats ; seuls les extraits lus peuvent servir de sources de code.

La validation des citations vérifie qu'une source a été récupérée et que les fichiers indiqués ont été lus. Elle ne prouve pas chaque interprétation du modèle. Le patch ne peut modifier que des chemins inspectés et doit contenir des en-têtes et hunks cohérents. Les tests, commandes de reproduction et commandes de validation présentés ne sont pas exécutés.

Les commentaires, README et fichiers sont traités comme des données non fiables. Ils ne peuvent créer aucune commande. « Implement » génère uniquement du texte au format patch dans la mémoire du navigateur. Le lancement local utilise exclusivement la recette `git`/`npm` déterminée par le serveur et l'autorisation de l'utilisateur. Les logs d'analyse contiennent les étapes, compteurs, durées et erreurs normalisées, sans clé ni corps des sources.

Les réponses GitHub publiques sont mises en cache brièvement ; les fichiers sont associés au SHA. Les analyses nécessaires aux actions suivantes expirent après 15 minutes et disparaissent au redémarrage. Une analyse d'une vieille issue porte sur le commit affiché, qui peut différer de la version affectée.

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

Les tests unitaires vérifient les accès, budgets, citations, changements de contexte, scoring Forensics, endpoints bornés et transitions. Les tests navigateur utilisent **le vrai runtime CopilotKit** avec un agent de test synthétique, sans appel externe. Ces données ne sont jamais chargées par l'application normale.

Le test extension charge le worker MV3 et le bundle dans Chromium, injecte la fenêtre flottante dans une page GitHub, détecte les changements d'issue et vérifie la CSP. Il parcourt Understand → Investigate → Propose → Implement, puis vérifie les liens GitHub, la copie et le téléchargement.

Arrêtez `npm run dev` ou `npm start` avant les tests navigateur : ils démarrent leurs propres serveurs sur les ports 3001 et 5173.

Pour un test réel GitHub + OpenAI (consomme des crédits API) :

```bash
npm run check:live -- https://github.com/expressjs/express/issues/7350 --solution
npm run check:live -- https://github.com/expressjs/express/issues/7350 --forensics
npm run check:live -- https://github.com/expressjs/express
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
- **Patch indisponible** : la solution contient encore des questions bloquantes, ou les extraits lus ne suffisent pas à produire un diff exact.

Le provider CopilotKit installé embarque aussi des composants différés inutilisés par cette interface. Le build signale donc un bundle volumineux ; les ressources restent empaquetées localement dans l'extension. Réduire ce poids est une optimisation ultérieure, sans impact sur le parcours principal validé.

## Construit pendant le hackathon

Le dépôt initial ne contenait que son titre. Le travail comprend le challenge de la V1, le périmètre V2, la collecte GitHub, l'agent OpenAI, l'intégration CopilotKit, l'interface sourcée, Issue Forensics, le briefing README avec box Bash, l'extension Chrome, les tests et la documentation. Les étapes sont enregistrées par commits sur `feat/mvp-issue-context`.

Voir [le plan challengé](docs/plan.md) et [la recette de démonstration](docs/demo.md).
