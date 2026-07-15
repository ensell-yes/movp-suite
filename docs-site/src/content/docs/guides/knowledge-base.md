---
title: Knowledge base template
description: Embeddable product content with hybrid search.
---

The Knowledge base template adds `kb_article` and `kb_category` project collections. Article
bodies are marked embeddable so the real search runtime can combine vector and full-text results.
Scaffold it:

```sh
npx create-movp
# choose: knowledge-base
```

Edit the project schema, run `npm run codegen`, then reset the local database to apply the
additive generated migration.
