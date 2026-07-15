---
title: Marketing site template
description: CMS content, SEO and AEO metadata, and publish scheduling.
---

The Marketing template combines the platform CMS with `author` and `newsletter_subscriber`
project collections. It includes SEO and AEO surfaces, scheduled publishing, an Astro site, and
seed content. Scaffold it:

```sh
npx create-movp
# choose: marketing-site
```

Edit the project schema, run `npm run codegen`, then reset the local database to apply the
additive generated migration.
