# First Messages VAPI — à coller dans la config des 3 assistants

Le **First Message** est le tout premier message que le client entend. Il est **statique** et lu
directement par ElevenLabs → l'orthographe doit être phonétique pour la voix.

**Règle d'orthographe de marque (voulue, ne pas « corriger ») :**
- Voix **française** → écrire **« Barracouda »** (avec « ou ») → se prononce « ba-ra-KOU-da ».
- Voix **anglaise** → écrire **« Barracuda »** (l'anglais le prononce bien nativement).

Objectifs des nouveaux First Messages : court (~4–5 s), une seule question, **aucune offre SMS**
dans l'accueil (elle est déplacée plus tard dans l'appel côté prompt).

---

## 1. Accueil « Premier contact » (FR)

```
Bonjour, ici Barry de Barracouda Piscines et Spas. Comment puis-je vous aider?
```

## 2. Spécialiste FR

```
Bonjour, ici Barry de Barracouda Piscines et Spas. Comment puis-je vous aider?
```
> Si ce spécialiste prend l'appel **après** l'accueil (transfert interne au squad), mets plutôt son
> `firstMessageMode` sur « ne parle pas en premier » pour éviter un double accueil.

## 3. Spécialiste EN

```
Hi, this is Barry from Barracuda Pools and Spas. How can I help you today?
```

---

## À vérifier après collage (test sur assistant cloné avant la prod)

1. Passer un appel FR : la voix dit bien « ba-ra-KOU-da » (pas « Baracuda » / « Barakuda »).
   - Si « Barracouda » sonne mal → tester « Barra-couda » ou une entrée dans le dictionnaire de
     prononciation VAPI/ElevenLabs si disponible.
2. Passer un appel EN : « Barracuda » se prononce correctement.
3. Vérifier qu'aucun assistant ne propose le SMS dès l'accueil.
4. Confirmer qu'il n'y a plus de « oui » ambigu qui déclenche un SMS inutile.

## Changements de prompts liés (déjà appliqués dans les fichiers du repo)

- `prompts/prompt-fr.txt` ligne 32 : formule d'accueil raccourcie + « Barracouda ».
- `prompts/prompt-fr.txt` (bloc « OFFRIR DE CONTINUER PAR TEXTO ») : l'offre SMS n'est plus au
  1er/2e tour — seulement plus tard (info à garder, demande non résolue, client pressé).
- `Ai.js` lignes 1294 / 1314 (injection persona backend) : hack « Barra-cuda » retiré ;
  FR → « Barracouda », EN → « Barracuda ». ⚠️ Modif backend = domaine Nathan, à redéployer sur Railway.
- `prompts/prompt-en.txt` : inchangé (l'accueil EN était déjà correct, pas de bloc SMS proactif).
```
