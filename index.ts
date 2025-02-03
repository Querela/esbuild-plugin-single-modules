import * as esbuild from "esbuild";
import fs from "node:fs";
import { dirname, sep as dirsep, join, parse, relative } from "node:path";

export interface singleModulesPluginOptions {
  /**
   * Filter regex for `esbuild.Plugin.onResolve()` method.
   * @default `.*` (match all)
   */
  filter: RegExp;
  /**
   * Number of path segments to drop from input/source files.
   *
   * E.g., for "./src/<file>" use 1 to get "./<file>"
   * @default undefined
   */
  numLevelsInputPathToDrop?: number;
  /**
   * Transform extensions of import/export statements, might be required for "out-extension" config.
   *
   * will run on all files filtered by `filter` parameter, so for any JS/TS if not restricted
   *
   * NOTE: currently only intended for changes from ".js", to e.g. ".mjs"
   * @default false
   */
  transformImportExtensions: boolean;
}

/**
 * Strips path segments from a given path. Will take segments from the root/left.
 *
 * E.g., to drop two (2) segments:
 * - `/a/b/c/d` -> `/c/d` (absolute path)
 * - `a/b/c/d` -> `c/d` (relative path)
 * - `./a/b/c/d` -> `./c/d` (relative path, keep `./`)
 *
 * NOTE: assumes linux paths, so `/` and `.`, without any protocols!
 *
 * @param path path from which to strip segments from
 * @param numSegments the number of path segments to strip, 0 for none, -1 is erro
 * @returns path with segments stripped
 */
function reducePathLeft(path: string, numSegments: number = 0) {
  if (numSegments === 0) return path;
  if (numSegments < 0) throw new Error("numSegments must not be negative!");
  const segments = path.split(dirsep);
  if (path.startsWith(dirsep) || path.startsWith(".")) {
    return segments
      .filter((_segment, index) => index === 0 || index > numSegments)
      .join(dirsep);
  } else {
    return segments
      .filter((_segment, index) => index > numSegments - 1)
      .join(dirsep);
  }
}

const IMPORT_PATTERN = /(?:import|from) ("|')((?:\.+\/)+.+(\.js))(?:\1);?/g;

export function singleModulesPlugin({
  filter = /.*/,
  numLevelsInputPathToDrop,
  transformImportExtensions = false,
}: singleModulesPluginOptions): esbuild.Plugin {
  // lookup to skip already processed files
  const seenFiles = new Set();
  // root directory for file path rewriting
  let root: string | undefined = undefined;

  return {
    name: "singleModulesPlugin",
    setup(build) {
      // options used for build call (clone to keep a copy for build calls later)
      const options = { ...build.initialOptions };

      // update output path
      if (
        Array.isArray(options.entryPoints) &&
        options.entryPoints?.length === 1 &&
        typeof options.entryPoints[0] === "string"
      ) {
        // this will probably only be called for the initial esbuild call

        const input = options.entryPoints[0];
        const relInputDir = reducePathLeft(
          dirname(input),
          numLevelsInputPathToDrop ?? 0
        );
        const output = join(relInputDir, parse(input).name);

        // for first build call, we need to adjust the inputs/output manually
        build.initialOptions.entryPoints = [{ in: input, out: output }];
      }

      // recursive builds (input/output params)
      const filespecs: { in: string; out: string }[] = [];
      // lookup to original file name if we transform imports
      const rewrittenImports = new Map<string, string>();

      build.onResolve({ filter: filter }, async (args) => {
        // do nothing for "entry-point"
        if (args.kind === "entry-point") {
          if (root === undefined) {
            root = args.resolveDir;
            // console.debug("Set root path to:", root);
          }
          return undefined;
        }

        // check for supported processing
        if (
          args.kind !== "import-statement" &&
          args.kind !== "dynamic-import"
        ) {
          throw new Error(
            `Unknown import path type: "${args.kind}", expected "import-statement" or "dynamic-import"`
          );
        }

        // if we enable import transformations, then we need to revert this in the lookup ...
        if (transformImportExtensions) {
          const origPath = rewrittenImports.get(
            `${args.importer}|${args.path}`
          );
          if (origPath !== undefined) args.path = origPath;
        }

        // this should now only be for "import-statement" or "dynamic-import"
        const file = join(args.resolveDir, args.path);

        // only process (build) file once, then skip
        if (!seenFiles.has(file)) {
          seenFiles.add(file);

          // compute input and output names
          if (root === undefined) {
            throw new Error("Project root path couldn't be determined!");
          }
          const relInput = relative(root, file);
          const relInputDir = reducePathLeft(
            dirname(relInput),
            numLevelsInputPathToDrop ?? 0
          );

          const input = "./" + relInput;
          const output = join(relInputDir, parse(input).name);

          // store input/output for batched processing
          filespecs.push({ in: input, out: output });
        }

        // set to external, so it will not be bundled
        return { external: true };
      });

      // start next builds
      build.onEnd(async (_result) => {
        if (filespecs.length > 0) {
          // run build on all the collected files
          await esbuild.build({
            ...options,
            entryPoints: filespecs,
          });
        }
      });

      // NOTE: for now, only support ".js" extension rewrites
      if (
        transformImportExtensions &&
        options.outExtension &&
        Object.getOwnPropertyNames(options.outExtension).includes(".js") &&
        options.outExtension[".js"] !== ".js"
      ) {
        const destExt = options.outExtension[".js"];

        build.onLoad({ filter: filter }, async (args) => {
          // inspired by
          // - https://github.com/gjsify/gjsify/blob/main/packages/infra/esbuild-plugin-transform-ext/src/plugin.ts
          // - https://esbuild.github.io/plugins/#on-load

          // load file contents
          let contents = await fs.promises.readFile(args.path, "utf8");

          // find all import statments with local imports: "../" or "./"
          const matches = Array.from(contents.matchAll(IMPORT_PATTERN));
          for (const match of matches) {
            const importFile = match[2]; // import source (filename)
            const newImportFile = importFile.replace(/\.js$/, destExt);
            rewrittenImports.set(`${args.path}|${newImportFile}`, importFile); // objects compare with id not value

            const importStr = match[0]; // whole import fragment
            // const transformed = importStr.replace(/\.js("|')(;?)$/, destExt + "$1$2"); // once should be enough?
            const newImportStr = importStr.replace(importFile, newImportFile); // once should be enough?
            contents = contents.replace(importStr, newImportStr);
          }

          return {
            contents: contents,
            loader: [".ts", ".mts", ".cts", ".tsx"].includes(
              parse(args.path).ext
            )
              ? "ts"
              : "js",
          };
        });
      }
    },
  };
}
