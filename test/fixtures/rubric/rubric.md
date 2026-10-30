# Pseudo-claims for the widget filter (fixture)

A six-row rubric page in the shape the scorer reads: claim 1 with lettered elements and a
wherein, two dependents, and a citations table with a legend.

## Set X: the widget filter

**1.** A method of filtering widgets from a catalog of widgets, comprising:

(a) receiving a catalog of widgets, each widget having a name and a weight;

(b) discarding every widget whose weight exceeds a threshold weight, the threshold being
read from a configuration file;

(c) ranking the remaining widgets by name length and reporting the ten longest names,

wherein the ranking is performed without a language model.

**2.** The method of claim 1, in which the threshold weight defaults to forty when the
configuration file names none.

**3.** The method of claim 1, further comprising caching the ranked names to a sidecar file
keyed by the catalog's path.

## Preamble variants for retrieval testing

- A method of selecting widgets by weight and name length.

## Citations and provenance

`wf` = `src/widgets/filter.js`, `cf` = `src/config.js`.

| claim | where | provenance |
|---|---|---|
| X1 preamble | `docs/WIDGETS.md:3-5` | A |
| X1(a) | `wf:10-24` (`loadCatalog`) | C |
| X1(b) | `wf:30-48` (`discardHeavy`), `cf:5-9` (`thresholdWeight`) | C |
| X1(c) | `wf:50-70`, `72-80` | C |
| X1 wherein | `wf` imports no model | C |
| X2 | `cf:5-9` | C |
| X3 | `src/widgets/cache.js:1-40` (`writeSidecar`) | C |
