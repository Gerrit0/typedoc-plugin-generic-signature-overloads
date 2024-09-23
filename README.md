# typedoc-plugin-generic-signature-overloads

Performs horrible hackery on TypeScript types to attempt to produce better
documentation for event emitter types. See
[TypeStrong/typedoc#2709](https://github.com/TypeStrong/typedoc/issues/2709) for
more details.

Requires TypeScript 5.6.2 as patch-package is used to expose internal functions.

To try this out:

```bash
npm i
npx tsc
npx typedoc --plugin ./dist/plugin.js src/testdata/events.ts
gio open docs/index.html
```

Not yet published to npm.

## To Do

-   [ ] Update TypeDoc patch to implement @inline
-   [ ] Unit test
-   [ ] CI

## Changelog

See full changelog [here](./CHANGELOG.md).
