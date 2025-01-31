# esbuild-plugin-single-modules

Plugin for [esbuild](https://esbuild.github.io/) to generate output files for each module. For a given input file, the import tree will be traversed and separate `esbuild`s will be started. This should allow better tree-shaking compared to a single bundle.

## Install

```shell
npm i esbuild esbuild-plugin-single-modules
```

## Usage

```js
import * as esbuild from "esbuild";
import { singleModulesPlugin } from "esbuild-plugin-single-modules";

await esbuild.build({
  // only single input file supported for now
  entryPoints: ["./src/index.js"],
  // where to place outputs, do not use `outfile`
  outdir: "dist",
  // required to traverse import graph
  bundle: true,
  // format: "esm", // e.g., to generate ESM build, uncomment this
  // how many path segments to drop from entryPoints/input,
  // we do not want to keep "src/" when we place them in "dist/", so let's drop one segment
  plugins: [singleModulesPlugin({ numLevelsInputPathToDrop: 1 })],
});
```
